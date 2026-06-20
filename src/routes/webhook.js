const express = require('express');
const router = express.Router();
const supabase = require('../models/supabase');
const { executeFlow, saveMessage, sendWhatsAppMessage, cancelFollowups, continueFlowFromButton } = require('../services/flowEngine');
const { getCountryFromPhone } = require('../utils/countryDetector');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

// ── GET /webhook/whatsapp — verificación de Meta ─────────────
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('[Webhook] Verificado por Meta ✓');
    return res.status(200).send(challenge);
  }
  console.warn('[Webhook] Verificación fallida');
  res.status(403).send('Forbidden');
});

// ── POST /webhook/whatsapp — mensajes entrantes ──────────────
router.post('/whatsapp', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = JSON.parse(req.body.toString());
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        for (const msg of value.messages || []) {
          const contactPhone = msg.from;
          const referral = msg.referral || null;

          if (msg.type === 'image') {
            console.log(`[Webhook] Imagen recibida de ${contactPhone}`);
            processIncomingImage(phoneNumberId, contactPhone, msg.image, referral).catch(err => {
              console.error('[Webhook] Error procesando imagen:', err.message);
            });
            continue;
          }

          if (msg.type !== 'text' && msg.type !== 'interactive') continue;

          const userMessage = msg.type === 'text'
            ? msg.text?.body || ''
            : msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';

          const isButtonReply = msg.type === 'interactive';

          if (!userMessage) continue;

          console.log(`[Webhook] Mensaje de ${contactPhone}: "${userMessage}" (botón: ${isButtonReply})`);

          processIncomingMessage(phoneNumberId, contactPhone, userMessage, isButtonReply, referral).catch(err => {
            console.error('[Webhook] Error procesando mensaje:', err.message);
          });
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Error parseando body:', err.message);
  }
});

function buildAdsFields(referral) {
  if (!referral) return {};
  return {
    ad_id: referral.source_id || null,
    ad_name: referral.headline || referral.body || null,
    campaign_id: referral.ctwa_clid || null,
    campaign_name: referral.source_url || null,
    adset_name: referral.media_type || null,
    source_ctwa: true
  };
}

// ── Verifica si el contacto pertenece a un país bloqueado ─────
async function isCountryBlocked(userId, contactPhone) {
  const countryCode = getCountryFromPhone(contactPhone);
  if (!countryCode) return false;

  const { data: blocked } = await supabase
    .from('blocked_countries')
    .select('country_code')
    .eq('user_id', userId)
    .eq('country_code', countryCode)
    .maybeSingle();

  if (blocked) {
    console.log(`[Webhook] País bloqueado: ${countryCode} (${contactPhone}) — mensaje ignorado por completo`);
    return true;
  }
  return false;
}

// ════════════════════════════════════════════════════════════
// Conversions API (CAPI): reportar venta a Meta
// ════════════════════════════════════════════════════════════
async function sendConversionEvent(userId, contactPhone, monto, ctwaClid) {
  try {
    const { data: adsConfig } = await supabase
      .from('ads_config')
      .select('pixel_id, access_token, currency, conversions_api')
      .eq('user_id', userId)
      .single();

    if (!adsConfig || !adsConfig.conversions_api || !adsConfig.pixel_id) {
      console.log('[CAPI] No hay config de CAPI activa, omitiendo evento');
      return;
    }

    const currency = adsConfig.currency || 'PEN';
    const pixelId = adsConfig.pixel_id;
    const accessToken = adsConfig.access_token;

    // Hashear el teléfono con SHA256 (requerido por Meta)
    const crypto = require('crypto');
    const phoneHash = crypto
      .createHash('sha256')
      .update(contactPhone.replace(/\D/g, ''))
      .digest('hex');

    const eventData = {
      data: [
        {
          event_name: 'Purchase',
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'business_messaging',
          messaging_channel: 'whatsapp',
          user_data: {
            ph: [phoneHash]
          },
          custom_data: {
            value: Number(monto),
            currency: currency
          },
          ...(ctwaClid ? { referrer_url: ctwaClid } : {})
        }
      ]
    };

    // Si tenemos el ctwa_clid, lo mandamos como parte del user_data
    if (ctwaClid) {
      eventData.data[0].user_data.ctwa_clid = ctwaClid;
    }

    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${pixelId}/events`,
      eventData,
      {
        params: { access_token: accessToken },
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      }
    );

    console.log(`[CAPI] Evento Purchase enviado a Meta. Respuesta:`, JSON.stringify(response.data));
  } catch (err) {
    console.error('[CAPI] Error enviando evento a Meta:', err.response?.data || err.message);
  }
}

async function processIncomingImage(phoneNumberId, contactPhone, imageData, referral = null) {
  const { data: connection } = await supabase
    .from('connections')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .eq('is_active', true)
    .single();

  if (!connection) {
    console.warn(`[Webhook] No se encontró conexión para phoneNumberId: ${phoneNumberId}`);
    return;
  }

  const userId = connection.user_id;

  if (await isCountryBlocked(userId, contactPhone)) {
    return;
  }

  let { data: conversation } = await supabase
    .from('conversations')
    .select('*')
    .eq('user_id', userId)
    .eq('contact_phone', contactPhone)
    .eq('connection_id', connection.id)
    .single();

  if (!conversation) {
    const { data: newConv } = await supabase
      .from('conversations')
      .insert({
        id: uuidv4(),
        user_id: userId,
        connection_id: connection.id,
        contact_phone: contactPhone,
        contact_name: contactPhone,
        status: 'active',
        unread_count: 1,
        last_message: '[Imagen]',
        last_message_at: new Date().toISOString(),
        ...buildAdsFields(referral)
      })
      .select()
      .single();
    conversation = newConv;
  }

  if (conversation.is_blocked) {
    console.log(`[Webhook] Conversación ${conversation.id} bloqueada — ignorando imagen`);
    return;
  }

  await saveMessage(conversation.id, '[Imagen recibida - posible comprobante]', 'inbound', 'image');

  if (conversation.flow_active === false) {
    console.log(`[Webhook] Flujo desactivado para ${conversation.id} — bot no responde más`);
    return;
  }

  let imageBuffer;
  try {
    const mediaInfo = await axios.get(
      `https://graph.facebook.com/v19.0/${imageData.id}`,
      { headers: { Authorization: `Bearer ${connection.access_token}` } }
    );
    const mediaUrl = mediaInfo.data.url;

    const imageResponse = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${connection.access_token}` },
      responseType: 'arraybuffer'
    });
    imageBuffer = Buffer.from(imageResponse.data);
  } catch (err) {
    console.error('[Payment] Error descargando imagen:', err.response?.data || err.message);
    return;
  }

  const base64Image = imageBuffer.toString('base64');
  const mimeType = imageData.mime_type || 'image/jpeg';

  const { data: paymentConfig } = await supabase
    .from('payment_config')
    .select('*')
    .eq('user_id', userId)
    .single();

  const msgConfirmacion = paymentConfig?.msg_confirmacion ||
    'Gracias por tu pago. Validaremos el comprobante y en breve te enviaremos el acceso.';
  const msgNoValido = paymentConfig?.msg_no_valido ||
    'Disculpa, no pudimos validar el comprobante. Por favor envía una foto más clara.';
  const msgTitularInvalido =
    'Disculpa, el comprobante no está dirigido a nuestra cuenta. Por favor verifica el destinatario e intenta de nuevo.';
  const titularEsperado = (paymentConfig?.titular || '').toLowerCase().trim();

  const apiKey = process.env.GROQ_API_KEY;
  let analysisResult = null;

  try {
    const visionResponse = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Analiza esta imagen. \u00bfEs un comprobante de pago (Yape, Plin, transferencia bancaria u otro)?\nSi lo es, extrae el MONTO exacto pagado (solo el numero, sin moneda).\nExtrae tambien el NOMBRE DEL DESTINATARIO/TITULAR al que se realizo el pago (puede aparecer como "Destino", "Para", "Titular", "Nombre").\nResponde SOLO en formato JSON exacto, sin texto adicional:\n{"es_comprobante": true/false, "monto": numero_o_null, "titular_destino": "nombre_o_null"}'
              },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64Image}` }
              }
            ]
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const rawText = visionResponse.data.choices[0].message.content.trim();
    console.log('[Payment Vision] Respuesta IA:', rawText);

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      analysisResult = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    console.error('[Payment Vision error]', err.response?.data || err.message);
  }

  if (!analysisResult || !analysisResult.es_comprobante) {
    console.log('[Payment] No es un comprobante válido');
    await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, msgNoValido);
    await saveMessage(conversation.id, msgNoValido, 'outbound', 'text');
    return;
  }

  if (titularEsperado) {
    const titularDetectado = (analysisResult.titular_destino || '').toLowerCase().trim();
    console.log(`[Payment] Titular esperado: "${titularEsperado}" | Detectado: "${titularDetectado}"`);

    if (titularDetectado && !titularDetectado.includes(titularEsperado) && !titularEsperado.includes(titularDetectado)) {
      console.log('[Payment] Titular no coincide — rechazando comprobante');
      await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, msgTitularInvalido);
      await saveMessage(conversation.id, msgTitularInvalido, 'outbound', 'text');
      return;
    }
  }

  await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, msgConfirmacion);
  await saveMessage(conversation.id, msgConfirmacion, 'outbound', 'text');

  const monto = analysisResult.monto;
  console.log(`[Payment] Comprobante válido, monto detectado: ${monto}`);

  if (monto !== null && monto !== undefined) {
    const { data: rules } = await supabase
      .from('payment_rules')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true);

    const matchedRule = (rules || []).find(r => Math.abs(Number(r.amount) - Number(monto)) < 0.5);

    if (matchedRule) {
      console.log(`[Payment] Regla encontrada para monto ${monto}, enviando acceso`);
      await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, matchedRule.access_message);
      await saveMessage(conversation.id, matchedRule.access_message, 'outbound', 'text');

      await supabase.from('conversations').update({
        is_sale: true,
        sale_amount: monto,
        sale_at: new Date().toISOString(),
        flow_active: false
      }).eq('id', conversation.id);

      await cancelFollowups(conversation.id);

      // Reportar venta a Meta Conversions API
      const ctwaClid = conversation.campaign_id || null;
      await sendConversionEvent(userId, contactPhone, monto, ctwaClid);

      console.log(`[Payment] Conversación ${conversation.id} marcada como venta. Bot desactivado.`);
    } else {
      console.log(`[Payment] No hay regla configurada para monto ${monto}`);
    }
  }
}

async function respondWithAI(userId, connection, contactPhone, userMessage, conversationId) {
  try {
    const { data: convData } = await supabase
      .from('conversations')
      .select('ai_config_id, active_price')
      .eq('id', conversationId)
      .single();

    let aiConfig = null;

    if (convData?.ai_config_id) {
      const { data: specificConfig } = await supabase
        .from('ai_config')
        .select('*')
        .eq('id', convData.ai_config_id)
        .single();
      aiConfig = specificConfig;
      console.log('[AI Fallback] Usando config IA de la conversación:', convData.ai_config_id);
    }

    if (!aiConfig) {
      const { data: globalConfig } = await supabase
        .from('ai_config')
        .select('*')
        .eq('user_id', userId)
        .eq('is_active', true)
        .single();
      aiConfig = globalConfig;
    }

    if (!aiConfig) {
      console.log('[AI Fallback] Sin configuración activa para user:', userId);
      return;
    }

    const apiKey = aiConfig.groq_api_key || process.env.GROQ_API_KEY;
    const model = aiConfig.model || 'meta-llama/llama-4-scout-17b-16e-instruct';
    let systemPrompt = aiConfig.system_prompt ||
      'Eres un asistente de ventas amable y profesional. Responde en español de forma concisa.';

    if (convData?.active_price) {
      systemPrompt += `\n\n⚠️ PRECIO ACTUALIZADO: El precio actual es S/${convData.active_price}. Usa SIEMPRE este precio.`;
    }

    const { data: history } = await supabase
      .from('messages')
      .select('content, direction')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(10);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...(history || []).slice(-8).map(m => ({
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        content: m.content
      })),
      { role: 'user', content: userMessage }
    ];

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model, max_tokens: 500, messages },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: (aiConfig.response_time || 10) * 1000
      }
    );

    const aiResponse = response.data.choices[0].message.content;
    console.log('[AI Fallback] Respuesta IA:', aiResponse.slice(0, 100));

    await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, aiResponse);
    await saveMessage(conversationId, aiResponse, 'outbound', 'text');

  } catch (err) {
    console.error('[AI Fallback error]', err.response?.data || err.message);
  }
}

async function processIncomingMessage(phoneNumberId, contactPhone, userMessage, isButtonReply = false, referral = null) {
  const { data: connection } = await supabase
    .from('connections')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .eq('is_active', true)
    .single();

  if (!connection) {
    console.warn(`[Webhook] No se encontró conexión para phoneNumberId: ${phoneNumberId}`);
    return;
  }

  const userId = connection.user_id;

  if (await isCountryBlocked(userId, contactPhone)) {
    return;
  }

  let { data: conversation } = await supabase
    .from('conversations')
    .select('*')
    .eq('user_id', userId)
    .eq('contact_phone', contactPhone)
    .eq('connection_id', connection.id)
    .single();

  if (!conversation) {
    const { data: newConv } = await supabase
      .from('conversations')
      .insert({
        id: uuidv4(),
        user_id: userId,
        connection_id: connection.id,
        contact_phone: contactPhone,
        contact_name: contactPhone,
        status: 'active',
        unread_count: 1,
        last_message: userMessage.slice(0, 100),
        last_message_at: new Date().toISOString(),
        ...buildAdsFields(referral)
      })
      .select()
      .single();
    conversation = newConv;
  }

  if (conversation.is_blocked) {
    console.log(`[Webhook] Conversación ${conversation.id} bloqueada — ignorando mensaje`);
    return;
  }

  await saveMessage(conversation.id, userMessage, 'inbound', 'text');

  if (conversation.flow_active === false) {
    console.log(`[Webhook] Flujo desactivado para ${conversation.id} — bot no responde más`);
    return;
  }

  const normalizedMsg = userMessage.toLowerCase().trim();

  if (isButtonReply) {
    console.log(`[Webhook] Respuesta de botón: "${userMessage}"`);

    if (conversation.current_flow_id && conversation.current_node_id) {
      try {
        const handled = await continueFlowFromButton(
          conversation.current_flow_id,
          conversation.current_node_id,
          userMessage,
          contactPhone,
          connection,
          conversation.id
        );
        if (handled) {
          console.log(`[Webhook] Flujo continuado desde botón "${userMessage}"`);
          return;
        }
      } catch (err) {
        console.error('[Webhook] Error continuando flujo desde botón:', err.message);
      }
    }

    console.log('[Webhook] Sin flujo pausado, usando IA fallback para botón');
    await respondWithAI(userId, connection, contactPhone, userMessage, conversation.id);
    return;
  }

  const { data: triggers } = await supabase
    .from('triggers')
    .select('*, flows(id, nodes, edges, is_active)')
    .eq('user_id', userId)
    .eq('connection_id', connection.id)
    .eq('is_active', true);

  if (!triggers?.length) {
    console.log(`[Webhook] Sin triggers — usando IA fallback`);
    await respondWithAI(userId, connection, contactPhone, userMessage, conversation.id);
    return;
  }

  const matchedTrigger = triggers.find(t => {
    const kw = t.keyword.toLowerCase().trim();
    return normalizedMsg === kw || normalizedMsg.includes(kw);
  });

  if (!matchedTrigger) {
    const defaultTrigger = triggers.find(t => t.keyword === '*' || t.keyword === 'default');
    if (defaultTrigger) {
      await executeFlow(defaultTrigger.flow_id, contactPhone, userMessage, connection, conversation.id);
    } else {
      console.log(`[Webhook] Sin coincidencia para "${normalizedMsg}" — usando IA fallback`);
      await respondWithAI(userId, connection, contactPhone, userMessage, conversation.id);
    }
    return;
  }

  if (!matchedTrigger.is_repeatable) {
    const { count } = await supabase
      .from('trigger_executions')
      .select('*', { count: 'exact', head: true })
      .eq('trigger_id', matchedTrigger.id)
      .eq('contact_phone', contactPhone);
    if (count > 0) {
      console.log(`[Webhook] Trigger no repetible ya ejecutado — usando IA fallback`);
      await respondWithAI(userId, connection, contactPhone, userMessage, conversation.id);
      return;
    }
  }

  await supabase.from('trigger_executions').insert({
    id: uuidv4(),
    trigger_id: matchedTrigger.id,
    contact_phone: contactPhone,
    conversation_id: conversation.id,
    executed_at: new Date().toISOString()
  });

  console.log(`[Webhook] Ejecutando flujo para trigger "${matchedTrigger.name}"`);
  await executeFlow(matchedTrigger.flow_id, contactPhone, userMessage, connection, conversation.id);
}

module.exports = router;