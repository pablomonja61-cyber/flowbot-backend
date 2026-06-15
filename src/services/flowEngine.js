const axios = require('axios');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');

// ── IA con Groq ──────────────────────────────────────────────
async function callGroqAI(systemPrompt, conversationHistory, userMessage, model) {
  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.slice(-10).map(m => ({
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        content: m.content
      })),
      { role: 'user', content: userMessage }
    ];

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: model || 'meta-llama/llama-4-scout-17b-16e-instruct',
        max_tokens: 500,
        messages
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (err) {
    console.error('[Groq error]', err.response?.data || err.message);
    return 'Lo siento, en este momento no puedo responder. Por favor intenta en unos minutos.';
  }
}

// ── Enviar mensaje de texto ──────────────────────────────────
async function sendWhatsAppMessage(phoneNumberId, accessToken, to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message }
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[WhatsApp] Texto enviado a ${to}`);
  } catch (err) {
    console.error('[WhatsApp send error]', err.response?.data || err.message);
  }
}

// ── Enviar imagen ────────────────────────────────────────────
async function sendWhatsAppImage(phoneNumberId, accessToken, to, imageUrl, caption) {
  try {
    if (!imageUrl || imageUrl.startsWith('data:')) {
      console.warn('[WhatsApp image] URL base64 no soportada, enviando caption como texto');
      if (caption) await sendWhatsAppMessage(phoneNumberId, accessToken, to, caption);
      return;
    }

    console.log(`[WhatsApp] Enviando imagen: ${imageUrl}`);

    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: {
          link: imageUrl,
          ...(caption ? { caption } : {})
        }
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[WhatsApp] Imagen enviada a ${to}`);
  } catch (err) {
    console.error('[WhatsApp image error]', err.response?.data || err.message);
    if (caption) await sendWhatsAppMessage(phoneNumberId, accessToken, to, caption);
  }
}

// ── Enviar botones (simple, sin imagen) ───────────────────────
async function sendWhatsAppButtons(phoneNumberId, accessToken, to, bodyText, buttons) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: {
            buttons: buttons.slice(0, 3).map((btn, i) => ({
              type: 'reply',
              reply: { id: `btn_${i}`, title: btn.slice(0, 20) }
            }))
          }
        }
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[WhatsApp buttons error]', err.response?.data || err.message);
    const text = bodyText + '\n\n' + buttons.map((b, i) => `${i + 1}. ${b}`).join('\n');
    await sendWhatsAppMessage(phoneNumberId, accessToken, to, text);
  }
}

// ── Enviar botones CON imagen de cabecera ─────────────────────
async function sendWhatsAppButtonsWithImage(phoneNumberId, accessToken, to, imageUrl, bodyText, footerText, buttons) {
  try {
    const interactive = {
      type: 'button',
      ...(imageUrl ? { header: { type: 'image', image: { link: imageUrl } } } : {}),
      body: { text: bodyText },
      ...(footerText ? { footer: { text: footerText } } : {}),
      action: {
        buttons: buttons.slice(0, 3).map((btn, i) => ({
          type: 'reply',
          reply: { id: `btn_${i}`, title: btn.slice(0, 20) }
        }))
      }
    };

    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[WhatsApp] Botones con imagen enviados a ${to}`);
  } catch (err) {
    console.error('[WhatsApp buttons+image error]', err.response?.data || err.message);
    if (imageUrl) {
      await sendWhatsAppImage(phoneNumberId, accessToken, to, imageUrl, '');
    }
    await sendWhatsAppButtons(phoneNumberId, accessToken, to, bodyText, buttons);
  }
}

// ── Reemplazo de variables {{...}} ─────────────────────────────
function replaceVariables(text, vars = {}) {
  if (!text) return text;
  let result = text;
  result = result.replace(/\{\{nombre\}\}/g, vars.nombre || '');
  result = result.replace(/\{\{telefono\}\}/g, vars.telefono || '');
  result = result.replace(/\{\{email\}\}/g, vars.email || '');
  result = result.replace(/\{\{origen\}\}/g, vars.origen || '');
  result = result.replace(/\{\{precio\}\}/g, vars.precio || '');
  return result;
}

// ── Espera ───────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Obtener config de IA por ID o la activa del usuario ───────
async function getAIConfig(aiConfigId, userId) {
  if (aiConfigId) {
    const { data } = await supabase
      .from('ai_config')
      .select('*')
      .eq('id', aiConfigId)
      .single();
    if (data) return data;
  }
  // Fallback: usar la config activa del usuario
  if (userId) {
    const { data } = await supabase
      .from('ai_config')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();
    if (data) return data;
  }
  return null;
}

// ════════════════════════════════════════════════════════════
// MOTOR DE FLUJOS
// ════════════════════════════════════════════════════════════
async function executeFlow(flowId, contactPhone, userMessage, connection, conversationId) {
  const { data: flow } = await supabase
    .from('flows')
    .select('*')
    .eq('id', flowId)
    .single();

  if (!flow || !flow.nodes?.length) return;

  const { data: history } = await supabase
    .from('messages')
    .select('content, direction')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(20);

  const { data: conv } = await supabase
    .from('conversations')
    .select('contact_name, contact_phone, contact_email, origen, active_price')
    .eq('id', conversationId)
    .single();

  const baseVars = {
    nombre: conv?.contact_name || '',
    telefono: conv?.contact_phone || contactPhone || '',
    email: conv?.contact_email || '',
    origen: conv?.origen || '',
    precio: conv?.active_price || ''
  };

  const nodeMap = {};
  flow.nodes.forEach(n => { nodeMap[n.id] = n; });

  const edgeMap = {};
  (flow.edges || []).forEach(e => {
    if (!edgeMap[e.source]) edgeMap[e.source] = [];
    edgeMap[e.source].push(e.target);
  });

  const startNode = flow.nodes.find(n => n.type === 'start' || n.type === 'trigger');
  if (!startNode) return;

  let currentNodeId = edgeMap[startNode.id]?.[0];
  let lastAiResponse = null;

  while (currentNodeId) {
    const node = nodeMap[currentNodeId];
    if (!node) break;

    console.log(`[Flow] Ejecutando nodo: ${node.type} (${node.id})`);
    console.log(`[Flow] Data del nodo:`, JSON.stringify(node.data));

    switch (node.type) {

      case 'message':
      case 'content': {
        const items = node.data?.items;

        if (items && Array.isArray(items) && items.length > 0) {
          for (const item of items) {
            const itemType = (item.type || '').toLowerCase();
            console.log(`[Flow] Procesando item tipo: ${itemType}, url: ${item.url}`);

            if (itemType === 'interval') {
              const seconds = item.seconds || 1;
              await sleep(Math.min(seconds * 1000, 30000));
              continue;
            }

            if (itemType === 'image' || itemType === 'imagen') {
              const caption = replaceVariables(item.caption || item.description || '', baseVars);
              await sendWhatsAppImage(
                connection.phone_number_id,
                connection.access_token,
                contactPhone,
                item.url || '',
                caption
              );
              await saveMessage(conversationId, caption || '[Imagen]', 'outbound', 'image', item.url || '');

            } else if (itemType === 'text' || itemType === 'texto') {
              const text = replaceVariables(item.text || item.content || item.contenido || '', baseVars);
              if (text) {
                await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, text);
                await saveMessage(conversationId, text, 'outbound', 'text');
              }

            } else if (itemType === 'audio') {
              const url = item.url || '';
              if (url && !url.startsWith('data:')) {
                try {
                  await axios.post(
                    `https://graph.facebook.com/v19.0/${connection.phone_number_id}/messages`,
                    { messaging_product: 'whatsapp', to: contactPhone, type: 'audio', audio: { link: url } },
                    { headers: { Authorization: `Bearer ${connection.access_token}`, 'Content-Type': 'application/json' } }
                  );
                  await saveMessage(conversationId, '[Audio]', 'outbound', 'audio', url);
                } catch (e) {
                  console.error('[WhatsApp audio error]', e.response?.data || e.message);
                }
              }

            } else if (itemType === 'video') {
              const url = item.url || '';
              if (url && !url.startsWith('data:')) {
                try {
                  const caption = replaceVariables(item.caption || '', baseVars);
                  await axios.post(
                    `https://graph.facebook.com/v19.0/${connection.phone_number_id}/messages`,
                    { messaging_product: 'whatsapp', to: contactPhone, type: 'video', video: { link: url, ...(caption ? { caption } : {}) } },
                    { headers: { Authorization: `Bearer ${connection.access_token}`, 'Content-Type': 'application/json' } }
                  );
                  await saveMessage(conversationId, caption || '[Video]', 'outbound', 'video', url);
                } catch (e) {
                  console.error('[WhatsApp video error]', e.response?.data || e.message);
                }
              }

            } else if (itemType === 'document' || itemType === 'doc') {
              const url = item.url || '';
              if (url && !url.startsWith('data:')) {
                try {
                  await axios.post(
                    `https://graph.facebook.com/v19.0/${connection.phone_number_id}/messages`,
                    { messaging_product: 'whatsapp', to: contactPhone, type: 'document', document: { link: url, filename: item.filename || 'documento.pdf' } },
                    { headers: { Authorization: `Bearer ${connection.access_token}`, 'Content-Type': 'application/json' } }
                  );
                  await saveMessage(conversationId, '[Documento]', 'outbound', 'document', url);
                } catch (e) {
                  console.error('[WhatsApp doc error]', e.response?.data || e.message);
                }
              }
            }

            await sleep(500);
          }

        } else {
          const text = replaceVariables(node.data?.text || node.data?.content || '', baseVars);
          if (text) {
            await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, text);
            await saveMessage(conversationId, text, 'outbound', 'text');
          }
        }

        if (node.data?.delay_seconds) {
          await sleep(node.data.delay_seconds * 1000);
        }
        break;
      }

      case 'api':
      case 'buttons':
      case 'api_message': {
        const text = replaceVariables(node.data?.body || node.data?.text || '', baseVars);
        const buttons = node.data?.buttons || [];
        const footer = replaceVariables(node.data?.footer || '', baseVars);
        const headerImageUrl = node.data?.headerType === 'Imagen' ? (node.data?.headerImage || '') : '';

        if (buttons.length > 0) {
          if (headerImageUrl) {
            await sendWhatsAppButtonsWithImage(
              connection.phone_number_id, connection.access_token, contactPhone,
              headerImageUrl, text, footer, buttons
            );
          } else {
            await sendWhatsAppButtons(connection.phone_number_id, connection.access_token, contactPhone, text, buttons);
          }
        } else if (text) {
          await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, text);
        }
        await saveMessage(conversationId, text, 'outbound', 'text');
        break;
      }

      case 'followup':
      case 'delay_followup': {
        const seguimientos = node.data?.seguimientos || [];

        for (const seg of seguimientos) {
          const minutos = seg.tiempo_minutos || 0;
          const precio = seg.precio || '';

          if (minutos > 0) {
            await scheduleFollowup(conversationId, contactPhone, connection.id, seg, minutos);
            console.log(`[Followup] Seguimiento "${seg.id}" programado para ${minutos} min`);
            continue;
          }

          if (precio) {
            await supabase.from('conversations').update({ active_price: precio }).eq('id', conversationId);
          }
          const segVars = { ...baseVars, precio: precio || baseVars.precio };
          await sendFollowupContents(connection, contactPhone, conversationId, seg.contenidos || [], segVars);
        }
        break;
      }

      // ── Agente IA — usa ai_config_id del nodo si existe ─────
      case 'ai':
      case 'ai_agent': {
        const aiConfigId = node.data?.ai_config_id || null;
        const aiConfig = await getAIConfig(aiConfigId, connection.user_id);

        let systemPrompt;
        let modelToUse = 'meta-llama/llama-4-scout-17b-16e-instruct';

        if (aiConfig) {
          systemPrompt = aiConfig.system_prompt || node.data?.context || 'Eres un asistente de ventas amable. Responde en español.';
          modelToUse = aiConfig.model || modelToUse;
          console.log(`[AI] Usando config "${aiConfig.name || aiConfig.id}"`);
        } else {
          systemPrompt = node.data?.context || node.data?.prompt || 'Eres un asistente de ventas amable y profesional. Responde en español.';
          console.log(`[AI] Usando prompt del nodo (sin config de IA seleccionada)`);
        }

        // Inyectar precio activo si existe
        const activePrice = conv?.active_price;
        if (activePrice) {
          systemPrompt += `\n\nIMPORTANTE: El precio actual de la oferta activa es ${activePrice}. Usa ESTE precio en tu respuesta, no menciones precios anteriores.`;
        }

        const aiResponse = await callGroqAI(systemPrompt, history || [], userMessage, modelToUse);
        lastAiResponse = aiResponse;
        await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, aiResponse);
        await saveMessage(conversationId, aiResponse, 'outbound', 'text');
        break;
      }

      case 'condition': {
        const variable = node.data?.variable || 'message';
        const operator = node.data?.operator || 'contains';
        const value = (node.data?.value || '').toLowerCase();
        const checkText = (variable === 'ai_response' ? lastAiResponse : userMessage || '').toLowerCase();

        let conditionMet = false;
        if (operator === 'contains') conditionMet = checkText.includes(value);
        else if (operator === 'equals') conditionMet = checkText === value;
        else if (operator === 'starts_with') conditionMet = checkText.startsWith(value);
        else if (operator === 'not_contains') conditionMet = !checkText.includes(value);

        const edges = (flow.edges || []).filter(e => e.source === currentNodeId);
        const yesEdge = edges.find(e => e.sourceHandle === 'yes' || e.label === 'sí');
        const noEdge = edges.find(e => e.sourceHandle === 'no' || e.label === 'no');
        currentNodeId = (conditionMet ? yesEdge : noEdge)?.target || null;
        continue;
      }

      case 'delay': {
        const seconds = node.data?.seconds || node.data?.value || 3;
        await sleep(Math.min(seconds * 1000, 30000));
        break;
      }

      case 'tag':
      case 'label': {
        const tag = node.data?.tag || '';
        if (tag) {
          const { data: convData } = await supabase.from('conversations')
            .select('tags').eq('id', conversationId).single();
          const currentTags = convData?.tags || [];
          await supabase.from('conversations')
            .update({ tags: [...currentTags, tag] })
            .eq('id', conversationId);
        }
        break;
      }

      case 'notification':
      case 'notify': {
        const notifyPhone = node.data?.phone || '';
        const msg = (node.data?.message || 'Nueva conversación: {{phone}}')
          .replace('{{phone}}', contactPhone)
          .replace('{{userNumber}}', contactPhone);
        if (notifyPhone) {
          await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, notifyPhone, msg);
        }
        break;
      }

      case 'end':
        currentNodeId = null;
        continue;
    }

    currentNodeId = edgeMap[currentNodeId]?.[0] || null;
  }
}

// ── Enviar los contenidos de un seguimiento ────────────────────
async function sendFollowupContents(connection, contactPhone, conversationId, contenidos, segVars) {
  for (const contenido of contenidos) {
    const tipo = (contenido.tipo || '').toLowerCase();

    if (tipo === 'texto') {
      const text = replaceVariables(contenido.texto || contenido.text || '', segVars);
      if (text) {
        await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, text);
        await saveMessage(conversationId, text, 'outbound', 'text');
      }

    } else if (tipo === 'imagen') {
      const caption = replaceVariables(contenido.caption || '', segVars);
      await sendWhatsAppImage(connection.phone_number_id, connection.access_token, contactPhone, contenido.url || '', caption);
      await saveMessage(conversationId, caption || '[Imagen]', 'outbound', 'image', contenido.url || '');

    } else if (tipo === 'audio') {
      const url = contenido.url || '';
      if (url) {
        try {
          await axios.post(
            `https://graph.facebook.com/v19.0/${connection.phone_number_id}/messages`,
            { messaging_product: 'whatsapp', to: contactPhone, type: 'audio', audio: { link: url } },
            { headers: { Authorization: `Bearer ${connection.access_token}`, 'Content-Type': 'application/json' } }
          );
          await saveMessage(conversationId, '[Audio]', 'outbound', 'audio', url);
        } catch (e) { console.error('[Followup audio error]', e.response?.data || e.message); }
      }

    } else if (tipo === 'video') {
      const url = contenido.url || '';
      const caption = replaceVariables(contenido.caption || '', segVars);
      if (url) {
        try {
          await axios.post(
            `https://graph.facebook.com/v19.0/${connection.phone_number_id}/messages`,
            { messaging_product: 'whatsapp', to: contactPhone, type: 'video', video: { link: url, ...(caption ? { caption } : {}) } },
            { headers: { Authorization: `Bearer ${connection.access_token}`, 'Content-Type': 'application/json' } }
          );
          await saveMessage(conversationId, caption || '[Video]', 'outbound', 'video', url);
        } catch (e) { console.error('[Followup video error]', e.response?.data || e.message); }
      }

    } else if (tipo === 'archivo' || tipo === 'documento' || tipo === 'doc') {
      const url = contenido.url || '';
      if (url) {
        try {
          await axios.post(
            `https://graph.facebook.com/v19.0/${connection.phone_number_id}/messages`,
            { messaging_product: 'whatsapp', to: contactPhone, type: 'document', document: { link: url, filename: contenido.filename || 'documento.pdf' } },
            { headers: { Authorization: `Bearer ${connection.access_token}`, 'Content-Type': 'application/json' } }
          );
          await saveMessage(conversationId, '[Documento]', 'outbound', 'document', url);
        } catch (e) { console.error('[Followup doc error]', e.response?.data || e.message); }
      }

    } else if (tipo === 'pausa') {
      const segs = contenido.segundos || contenido.seconds || 1;
      await sleep(Math.min(segs * 1000, 30000));

    } else if (tipo === 'botones') {
      const mensaje = replaceVariables(contenido.mensaje || '', segVars);
      const pie = replaceVariables(contenido.pie || '', segVars);
      const botones = contenido.botones || [];
      const imagenCabecera = contenido.imagen_cabecera || '';

      if (botones.length > 0) {
        if (imagenCabecera) {
          await sendWhatsAppButtonsWithImage(connection.phone_number_id, connection.access_token, contactPhone, imagenCabecera, mensaje, pie, botones);
        } else {
          await sendWhatsAppButtons(connection.phone_number_id, connection.access_token, contactPhone, mensaje, botones);
        }
      } else if (mensaje) {
        await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, mensaje);
      }
      await saveMessage(conversationId, mensaje, 'outbound', 'text');
    }

    await sleep(500);
  }
}

// ── Programar un seguimiento para envío diferido ───────────────
async function scheduleFollowup(conversationId, contactPhone, connectionId, seg, minutos) {
  const sendAt = new Date(Date.now() + minutos * 60 * 1000).toISOString();
  await supabase.from('scheduled_followups').insert({
    id: uuidv4(),
    conversation_id: conversationId,
    connection_id: connectionId,
    contact_phone: contactPhone,
    followup_data: seg,
    status: 'pending',
    send_at: sendAt,
    created_at: new Date().toISOString()
  });
}

// ── Cancelar seguimientos pendientes de una conversación ───────
async function cancelFollowups(conversationId) {
  await supabase
    .from('scheduled_followups')
    .update({ status: 'cancelled' })
    .eq('conversation_id', conversationId)
    .eq('status', 'pending');
}

// ── Scheduler: revisa y envía seguimientos pendientes ──────────
async function runScheduler() {
  try {
    const now = new Date().toISOString();
    console.log(`[Scheduler] Corriendo, hora actual: ${now}`);

    const { data: pending, error } = await supabase
      .from('scheduled_followups')
      .select('*')
      .eq('status', 'pending')
      .lte('send_at', now);

    console.log(`[Scheduler] Pending encontrados: ${pending?.length || 0}, error: ${error?.message || 'ninguno'}`);

    if (!pending?.length) return;

    for (const followup of pending) {
      const { data: conv } = await supabase
        .from('conversations')
        .select('*')
        .eq('id', followup.conversation_id)
        .single();

      if (!conv || conv.is_sale || conv.is_blocked || conv.flow_active === false) {
        console.log(`[Scheduler] Saltando — conversación ${followup.conversation_id} ya compró o está apagada/bloqueada`);
        await supabase.from('scheduled_followups').update({ status: 'cancelled' }).eq('id', followup.id);
        continue;
      }

      const { data: connection } = await supabase
        .from('connections')
        .select('*')
        .eq('id', followup.connection_id)
        .single();

      if (!connection) {
        await supabase.from('scheduled_followups').update({ status: 'failed' }).eq('id', followup.id);
        continue;
      }

      const seg = followup.followup_data || {};
      const precio = seg.precio || '';

      if (precio) {
        await supabase.from('conversations').update({ active_price: precio }).eq('id', conv.id);
      }

      const segVars = {
        nombre: conv.contact_name || '',
        telefono: conv.contact_phone || followup.contact_phone || '',
        email: conv.contact_email || '',
        origen: conv.origen || '',
        precio: precio || conv.active_price || ''
      };

      await sendFollowupContents(connection, followup.contact_phone, conv.id, seg.contenidos || [], segVars);
      await supabase.from('scheduled_followups').update({ status: 'sent' }).eq('id', followup.id);
      console.log(`[Scheduler] Seguimiento ${followup.id} enviado`);
    }
  } catch (err) {
    console.error('[Scheduler error]', err.message);
  }
}

// ── Guardar mensaje ──────────────────────────────────────────
async function saveMessage(conversationId, content, direction, msgType = 'text', mediaUrl = null) {
  if (!conversationId || !content) return;
  await supabase.from('messages').insert({
    conversation_id: conversationId,
    content,
    direction,
    msg_type: msgType,
    media_url: mediaUrl,
    created_at: new Date().toISOString()
  });
  await supabase.from('conversations').update({
    last_message: content.slice(0, 100),
    last_message_at: new Date().toISOString(),
    ...(direction === 'inbound' ? { unread_count: 1 } : {})
  }).eq('id', conversationId);
}

module.exports = { executeFlow, saveMessage, sendWhatsAppMessage, cancelFollowups, runScheduler };