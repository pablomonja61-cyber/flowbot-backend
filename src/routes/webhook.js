const express = require('express');
const router = express.Router();
const supabase = require('../models/supabase');
const { executeFlow, saveMessage, sendWhatsAppMessage } = require('../services/flowEngine');
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

          if (msg.type === 'image') {
            console.log(`[Webhook] Imagen recibida de ${contactPhone}`);
            processIncomingImage(phoneNumberId, contactPhone, msg.image).catch(err => {
              console.error('[Webhook] Error procesando imagen:', err.message);
            });
            continue;
          }

          if (msg.type !== 'text' && msg.type !== 'interactive') continue;

          const isButtonReply = msg.type === 'interactive';

          // Para botones, capturamos el ID del botón además del título
          const buttonId = isButtonReply
            ? (msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || '')
            : '';

          const userMessage = isButtonReply
            ? (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '')
            : (msg.text?.body || '');

          if (!userMessage) continue;

          console.log(`[Webhook] Mensaje de ${contactPhone}: "${userMessage}" (botón: ${isButtonReply}, buttonId: ${buttonId})`);

          processIncomingMessage(phoneNumberId, contactPhone, userMessage, isButtonReply, buttonId).catch(err => {
            console.error('[Webhook] Error procesando mensaje:', err.message);
          });
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Error parseando body:', err.message);
  }
});

// ════════════════════════════════════════════════════════════
// Procesar IMAGEN entrante (posible comprobante de pago)
// ════════════════════════════════════════════════════════════
async function processIncomingImage(phoneNumberId, contactPhone, imageData) {
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
        last_message_at: new Date().toISOString()
      })
      .select()
      .single();
    conversation = newConv;
  }

  await saveMessage(conversation.id, '[Imagen recibida - posible comprobante]', 'inbound', 'image');

  // 1. Descargar la imagen de WhatsApp
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

  // 2. Obtener config de pagos del usuario
  const { data: paymentConfig } = await supabase
    .from('payment_config')
    .select('*')
    .eq('user_id', userId)
    .single();

  const msgConfirmacion = paymentConfig?.msg_confirmacion ||
    'Gracias por tu pago. Validaremos el comprobante y en breve te enviaremos el acceso.';
  const msgNoValido = paymentConfig?.msg_no_valido ||
    'Disculpa, no pudimos validar el comprobante. Por favor envía una foto más clara.';

  // 3. Analizar la imagen con Groq Vision
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
                text: `Analiza esta imagen. ¿Es un comprobante de pago (Yape, Plin, transferencia bancaria u otro)?
Si lo es, extrae el MONTO exacto pagado (solo el número, sin moneda).
Responde SOLO en formato JSON exacto, sin texto adicional:
{"es_comprobante": true/false, "monto": numero_o_null}`
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

  // 4. Decidir respuesta según análisis
  if (!analysisResult || !analysisResult.es_comprobante) {
    console.log('[Payment] No es un comprobante válido');
    await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, msgNoValido);
    await saveMessage(conversation.id, msgNoValido, 'outbound', 'text');
    return;
  }

  // Es un comprobante válido
  await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, msgConfirmacion);
  await saveMessage(conversation.id, msgConfirmacion, 'outbound', 'text');

  const monto = analysisResult.monto;
  console.log(`[Payment] Comprobante válido, monto detectado: ${monto}`);

  // 5. Buscar regla de acceso que coincida con el monto
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
        sale_at: new Date().toISOString()
      }).eq('id', conversation.id);
    } else {
      console.log(`[Payment] No hay regla configurada para monto ${monto}`);
    }
  }
}

// ── Responder con IA usando config de Supabase ───────────────
async function respondWithAI(userId, connection, contactPhone, userMessage, conversationId) {
  try {
    const { data: aiConfig } = await supabase
      .from('ai_config')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (!aiConfig || !aiConfig.is_active) {
      console.log('[AI Fallback] IA desactivada o sin configurar para user:', userId);
      return;
    }

    const apiKey = aiConfig.groq_api_key || process.env.GROQ_API_KEY;
    const model = aiConfig.model || 'meta-llama/llama-4-scout-17b-16e-instruct';
    const systemPrompt = aiConfig.system_prompt ||
      'Eres un asistente de ventas amable y profesional. Responde en español de forma concisa.';

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

// ════════════════════════════════════════════════════════════
// Lógica principal: texto / botones
// ════════════════════════════════════════════════════════════
async function processIncomingMessage(phoneNumberId, contactPhone, userMessage, isButtonReply = false, buttonId = '') {
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
        last_message_at: new Date().toISOString()
      })
      .select()
      .single();
    conversation = newConv;
  }

  await saveMessage(conversation.id, userMessage, 'inbound', 'text');

  const normalizedMsg = userMessage.toLowerCase().trim();

  // ── SI ES RESPUESTA DE BOTÓN: continuar el flujo pendiente ──
  if (isButtonReply) {
    console.log(`[Webhook] Botón presionado: "${userMessage}" (id: ${buttonId})`);

    // Buscar si hay un flujo en progreso para este contacto
    const { data: flowState } = await supabase
      .from('flow_states')
      .select('*')
      .eq('conversation_id', conversation.id)
      .eq('status', 'waiting_button')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (flowState) {
      console.log(`[Webhook] Continuando flujo ${flowState.flow_id} desde nodo ${flowState.current_node_id}`);
      await supabase
        .from('flow_states')
        .update({ status: 'completed' })
        .eq('id', flowState.id);

      await executeFlow(
        flowState.flow_id,
        contactPhone,
        userMessage,
        connection,
        conversation.id,
        {
          resumeFromNodeId: flowState.current_node_id,
          buttonPressed: userMessage,
          buttonId: buttonId
        }
      );
      return;
    }

    // Sin flujo pendiente → la IA responde con contexto
    console.log(`[Webhook] Sin flujo pendiente para botón — usando IA fallback`);
    await respondWithAI(userId, connection, contactPhone, userMessage, conversation.id);
    return;
  }

  // ── MENSAJE DE TEXTO NORMAL ──
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
      await executeFlow(
        defaultTrigger.flow_id,
        contactPhone,
        userMessage,
        connection,
        conversation.id
      );
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
      console.log(`[Webhook] Trigger no repetible ya ejecutado para ${contactPhone}`);
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
  await executeFlow(
    matchedTrigger.flow_id,
    contactPhone,
    userMessage,
    connection,
    conversation.id
  );
}

module.exports = router;
