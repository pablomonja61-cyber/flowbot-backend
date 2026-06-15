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

// ── Obtener config de IA del usuario ────────────────────────
async function getAIConfig(userId) {
  try {
    const { data } = await supabase
      .from('ai_config')
      .select('*')
      .eq('user_id', userId)
      .single();
    return data;
  } catch (err) {
    return null;
  }
}

// ── Reemplazar variables en texto ────────────────────────────
function replaceVariables(text, vars = {}) {
  if (!text) return text;
  return text
    .replace(/\{\{nombre\}\}/g, vars.nombre || '')
    .replace(/\{\{telefono\}\}/g, vars.telefono || '')
    .replace(/\{\{email\}\}/g, vars.email || '')
    .replace(/\{\{origen\}\}/g, vars.origen || '')
    .replace(/\{\{precio\}\}/g, vars.precio || '')
    .replace(/\{\{phone\}\}/g, vars.telefono || '')
    .replace(/\{\{userNumber\}\}/g, vars.telefono || '');
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
      if (caption) await sendWhatsAppMessage(phoneNumberId, accessToken, to, caption);
      return;
    }
    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: { link: imageUrl, ...(caption ? { caption } : {}) }
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[WhatsApp image error]', err.response?.data || err.message);
    if (caption) await sendWhatsAppMessage(phoneNumberId, accessToken, to, caption);
  }
}

// ── Enviar botones ───────────────────────────────────────────
async function sendWhatsAppButtons(phoneNumberId, accessToken, to, bodyText, buttons, headerImageUrl) {
  try {
    const interactive = {
      type: 'button',
      body: { text: bodyText || ' ' },
      action: {
        buttons: buttons.slice(0, 3).map((btn, i) => ({
          type: 'reply',
          reply: { id: `btn_${i}`, title: (btn.titulo || btn.title || btn).slice(0, 20) }
        }))
      }
    };

    if (headerImageUrl && !headerImageUrl.startsWith('data:')) {
      interactive.header = { type: 'image', image: { link: headerImageUrl } };
    }

    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'interactive', interactive },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[WhatsApp buttons error]', err.response?.data || err.message);
    const text = (bodyText || '') + '\n\n' + buttons.map((b, i) => `${i + 1}. ${b.titulo || b.title || b}`).join('\n');
    await sendWhatsAppMessage(phoneNumberId, accessToken, to, text);
  }
}

// ── Espera ───────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Guardar estado del flujo (pausa en botones) ──────────────
async function saveFlowState(conversationId, flowId, nodeId) {
  try {
    await supabase.from('flow_states').upsert({
      conversation_id: conversationId,
      flow_id: flowId,
      current_node_id: nodeId,
      status: 'waiting_button',
      created_at: new Date().toISOString()
    }, { onConflict: 'conversation_id' });
    console.log(`[Flow] Estado guardado — esperando botón en nodo ${nodeId}`);
  } catch (err) {
    console.error('[Flow] Error guardando estado:', err.message);
  }
}

// ── Limpiar estado del flujo ─────────────────────────────────
async function clearFlowState(conversationId) {
  try {
    await supabase.from('flow_states')
      .delete()
      .eq('conversation_id', conversationId);
  } catch (err) {
    console.error('[Flow] Error limpiando estado:', err.message);
  }
}

// ── Programar seguimiento ────────────────────────────────────
async function scheduleFollowup(conversationId, connectionId, contactPhone, segData, vars, delayMinutes) {
  try {
    const sendAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
    await supabase.from('scheduled_followups').insert({
      id: uuidv4(),
      conversation_id: conversationId,
      connection_id: connectionId,
      contact_phone: contactPhone,
      seg_data: segData,
      vars: vars,
      send_at: sendAt,
      status: 'pending'
    });
    console.log(`[Followup] Programado para ${delayMinutes} minutos — send_at: ${sendAt}`);
  } catch (err) {
    console.error('[Followup] Error programando:', err.message);
  }
}

// ── Cancelar seguimientos pendientes (cuando hay pago) ───────
async function cancelFollowups(conversationId) {
  try {
    await supabase.from('scheduled_followups')
      .update({ status: 'cancelled' })
      .eq('conversation_id', conversationId)
      .eq('status', 'pending');
    console.log(`[Followup] Seguimientos cancelados para conversación ${conversationId}`);
  } catch (err) {
    console.error('[Followup] Error cancelando:', err.message);
  }
}

// ── Enviar contenido de seguimiento ─────────────────────────
async function sendFollowupContents(contenidos, connection, contactPhone, conversationId, vars) {
  for (const contenido of contenidos) {
    const tipo = (contenido.tipo || '').toLowerCase();

    if (tipo === 'texto' || tipo === 'text') {
      const texto = replaceVariables(contenido.texto || contenido.text || '', vars);
      if (texto) {
        await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, texto);
        await saveMessage(conversationId, texto, 'outbound', 'text');
      }
    } else if (tipo === 'imagen' || tipo === 'image') {
      const url = contenido.url || '';
      const caption = replaceVariables(contenido.caption || '', vars);
      await sendWhatsAppImage(connection.phone_number_id, connection.access_token, contactPhone, url, caption);
      await saveMessage(conversationId, caption || '[Imagen]', 'outbound', 'image', url);
    } else if (tipo === 'botones' || tipo === 'buttons') {
      const mensaje = replaceVariables(contenido.mensaje || contenido.message || '', vars);
      const pie = replaceVariables(contenido.pie || '', vars);
      const botones = contenido.botones || contenido.buttons || [];
      const headerImg = contenido.imagen_cabecera || contenido.header_image || '';
      const textoCompleto = mensaje + (pie ? `\n\n_${pie}_` : '');
      if (botones.length > 0) {
        await sendWhatsAppButtons(connection.phone_number_id, connection.access_token, contactPhone, textoCompleto, botones, headerImg);
      } else if (textoCompleto) {
        await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, textoCompleto);
      }
      await saveMessage(conversationId, textoCompleto || '[Botones]', 'outbound', 'text');
    } else if (tipo === 'audio') {
      const url = contenido.url || '';
      if (url && !url.startsWith('data:')) {
        try {
          await axios.post(`https://graph.facebook.com/v19.0/${connection.phone_number_id}/messages`,
            { messaging_product: 'whatsapp', to: contactPhone, type: 'audio', audio: { link: url } },
            { headers: { Authorization: `Bearer ${connection.access_token}`, 'Content-Type': 'application/json' } });
          await saveMessage(conversationId, '[Audio]', 'outbound', 'audio', url);
        } catch (e) { console.error('[audio]', e.message); }
      }
    } else if (tipo === 'video') {
      const url = contenido.url || '';
      if (url && !url.startsWith('data:')) {
        try {
          await axios.post(`https://graph.facebook.com/v19.0/${connection.phone_number_id}/messages`,
            { messaging_product: 'whatsapp', to: contactPhone, type: 'video', video: { link: url, ...(contenido.caption ? { caption: contenido.caption } : {}) } },
            { headers: { Authorization: `Bearer ${connection.access_token}`, 'Content-Type': 'application/json' } });
          await saveMessage(conversationId, contenido.caption || '[Video]', 'outbound', 'video', url);
        } catch (e) { console.error('[video]', e.message); }
      }
    } else if (tipo === 'pausa' || tipo === 'pause') {
      const segundos = contenido.segundos || contenido.seconds || 2;
      await sleep(Math.min(segundos * 1000, 30000));
    }

    await sleep(500);
  }
}

// ── Scheduler de seguimientos ────────────────────────────────
async function runScheduler() {
  try {
    const now = new Date().toISOString();
    const { data: pendingFollowups } = await supabase
      .from('scheduled_followups')
      .select('*, connections(*)')
      .eq('status', 'pending')
      .lte('send_at', now);

    if (!pendingFollowups?.length) return;

    for (const followup of pendingFollowups) {
      try {
        const { data: conv } = await supabase
          .from('conversations')
          .select('is_sale')
          .eq('id', followup.conversation_id)
          .single();

        if (conv?.is_sale) {
          await supabase.from('scheduled_followups')
            .update({ status: 'cancelled' })
            .eq('id', followup.id);
          console.log(`[Scheduler] Seguimiento cancelado — conversación ${followup.conversation_id} ya tiene venta`);
          continue;
        }

        const connection = followup.connections;
        if (!connection) {
          await supabase.from('scheduled_followups').update({ status: 'failed' }).eq('id', followup.id);
          continue;
        }

        const vars = followup.vars || {};
        const segData = followup.seg_data || {};
        const contenidos = segData.contenidos || [];

        if (contenidos.length > 0) {
          await sendFollowupContents(contenidos, connection, followup.contact_phone, followup.conversation_id, vars);
        }

        await supabase.from('scheduled_followups')
          .update({ status: 'sent' })
          .eq('id', followup.id);

        console.log(`[Scheduler] Seguimiento enviado a ${followup.contact_phone}`);
      } catch (err) {
        console.error(`[Scheduler] Error en followup ${followup.id}:`, err.message);
        await supabase.from('scheduled_followups').update({ status: 'failed' }).eq('id', followup.id);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Error general:', err.message);
  }
}

// Iniciar scheduler cada 60 segundos
setInterval(runScheduler, 60000);
console.log('[Scheduler] Iniciado — revisando seguimientos cada 60 segundos');

// ════════════════════════════════════════════════════════════
// MOTOR DE FLUJOS
// ════════════════════════════════════════════════════════════
async function executeFlow(flowId, contactPhone, userMessage, connection, conversationId, preloadedFlow) {
  let flow = preloadedFlow;

  if (!flow) {
    const { data } = await supabase
      .from('flows')
      .select('*')
      .eq('id', flowId)
      .single();
    flow = data;
  }

  if (!flow || !flow.nodes?.length) return;

  const { data: history } = await supabase
    .from('messages')
    .select('content, direction')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(20);

  const { data: conv } = await supabase
    .from('conversations')
    .select('contact_name, contact_phone')
    .eq('id', conversationId)
    .single();

  const vars = {
    nombre: conv?.contact_name || contactPhone,
    telefono: contactPhone,
    email: '',
    origen: '',
    precio: ''
  };

  const nodeMap = {};
  flow.nodes.forEach(n => { nodeMap[n.id] = n; });

  const edgeMap = {};
  (flow.edges || []).forEach(e => {
    if (!edgeMap[e.source]) edgeMap[e.source] = [];
    edgeMap[e.source].push({ target: e.target, sourceHandle: e.sourceHandle });
  });

  let currentNodeId;
  const startNode = flow.nodes.find(n => n.type === 'start' || n.type === 'trigger');
  if (!startNode) return;
  currentNodeId = edgeMap[startNode.id]?.[0]?.target;

  let lastAiResponse = null;

  while (currentNodeId) {
    const node = nodeMap[currentNodeId];
    if (!node) break;

    console.log(`[Flow] Ejecutando nodo: ${node.type} (${node.id})`);

    switch (node.type) {

      case 'message':
      case 'content': {
        const items = node.data?.items;

        if (items && Array.isArray(items) && items.length > 0) {
          for (const item of items) {
            const itemType = (item.type || '').toLowerCase();

            if (itemType === 'image' || itemType === 'imagen') {
              await sendWhatsAppImage(connection.phone_number_id, connection.access_token, contactPhone, item.url || '', item.caption || item.description || '');
              await saveMessage(conversationId, item.caption || '[Imagen]', 'outbound', 'image', item.url || '');
            } else if (itemType === 'text' || itemType === 'texto') {
              const text = replaceVariables(item.text || item.content || '', vars);
              if (text) {
                await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, text);
                await saveMessage(conversationId, text, 'outbound', 'text');
              }
            } else if (itemType === 'audio') {
              const url = item.url || '';
              if (url && !url.startsWith('data:')) {
                try {
                  await axios.post(`https://graph.facebook.com/v19.0/${connection.phone_number_id}/messages`,
                    { messaging_product: 'whatsapp', to: contactPhone, type: 'audio', audio: { link: url } },
                    { headers: { Authorization: `Bearer ${connection.access_token}`, 'Content-Type': 'application/json' } });
                  await saveMessage(conversationId, '[Audio]', 'outbound', 'audio', url);
                } catch (e) { console.error('[audio]', e.message); }
              }
            } else if (itemType === 'video') {
              const url = item.url || '';
              if (url && !url.startsWith('data:')) {
                try {
                  await axios.post(`https://graph.facebook.com/v19.0/${connection.phone_number_id}/messages`,
                    { messaging_product: 'whatsapp', to: contactPhone, type: 'video', video: { link: url, ...(item.caption ? { caption: item.caption } : {}) } },
                    { headers: { Authorization: `Bearer ${connection.access_token}`, 'Content-Type': 'application/json' } });
                  await saveMessage(conversationId, item.caption || '[Video]', 'outbound', 'video', url);
                } catch (e) { console.error('[video]', e.message); }
              }
            } else if (itemType === 'document' || itemType === 'doc') {
              const url = item.url || '';
              if (url && !url.startsWith('data:')) {
                try {
                  await axios.post(`https://graph.facebook.com/v19.0/${connection.phone_number_id}/messages`,
                    { messaging_product: 'whatsapp', to: contactPhone, type: 'document', document: { link: url, filename: item.filename || 'documento.pdf' } },
                    { headers: { Authorization: `Bearer ${connection.access_token}`, 'Content-Type': 'application/json' } });
                  await saveMessage(conversationId, '[Documento]', 'outbound', 'document', url);
                } catch (e) { console.error('[doc]', e.message); }
              }
            }
            await sleep(500);
          }
        } else {
          const text = replaceVariables(node.data?.text || node.data?.content || '', vars);
          if (text) {
            await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, text);
            await saveMessage(conversationId, text, 'outbound', 'text');
          }
        }

        if (node.data?.delay_seconds) await sleep(node.data.delay_seconds * 1000);
        break;
      }

      case 'api':
      case 'buttons':
      case 'api_message': {
        const text = replaceVariables(node.data?.body || node.data?.text || '', vars);
        const buttons = node.data?.buttons || [];

        if (buttons.length > 0) {
          await sendWhatsAppButtons(connection.phone_number_id, connection.access_token, contactPhone, text, buttons);
        } else if (text) {
          await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, text);
        }

        await saveMessage(conversationId, text, 'outbound', 'text');

        // PAUSA — guardar estado y detener el flujo
        await saveFlowState(conversationId, flow.id, node.id);
        console.log(`[Flow] Pausado en nodo de botones ${node.id} — esperando respuesta del cliente`);
        return;
      }

      case 'ai':
      case 'ai_agent': {
        const aiConfig = await getAIConfig(connection.user_id);
        const systemPrompt = node.data?.context || node.data?.prompt ||
          aiConfig?.system_prompt ||
          'Eres un asistente de ventas amable y profesional. Responde en español.';
        const model = aiConfig?.model || 'meta-llama/llama-4-scout-17b-16e-instruct';
        const aiResponse = await callGroqAI(systemPrompt, history || [], userMessage, model);
        lastAiResponse = aiResponse;
        await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, aiResponse);
        await saveMessage(conversationId, aiResponse, 'outbound', 'text');
        break;
      }

      case 'followup':
      case 'seguimiento': {
        const seguimientos = node.data?.seguimientos || [];
        if (seguimientos.length === 0) break;

        for (const seg of seguimientos) {
          const tiempoMinutos = seg.tiempo_minutos || 0;
          if (seg.precio) vars.precio = seg.precio;

          if (tiempoMinutos <= 0) {
            await sendFollowupContents(seg.contenidos || [], connection, contactPhone, conversationId, vars);
          } else if (tiempoMinutos * 60 * 1000 <= 30000) {
            await sleep(tiempoMinutos * 60 * 1000);
            await sendFollowupContents(seg.contenidos || [], connection, contactPhone, conversationId, vars);
          } else {
            await scheduleFollowup(conversationId, connection.id, contactPhone, seg, { ...vars }, tiempoMinutos);
          }

          await sleep(1000);
        }
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
          const { data: convData } = await supabase.from('conversations').select('tags').eq('id', conversationId).single();
          const currentTags = convData?.tags || [];
          await supabase.from('conversations').update({ tags: [...currentTags, tag] }).eq('id', conversationId);
        }
        break;
      }

      case 'notification':
      case 'notify': {
        const notifyPhone = node.data?.phone || '';
        const msg = replaceVariables(node.data?.message || 'Nueva conversación: {{telefono}}', vars);
        if (notifyPhone) {
          await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, notifyPhone, msg);
        }
        break;
      }

      case 'end':
        currentNodeId = null;
        continue;
    }

    currentNodeId = edgeMap[currentNodeId]?.[0]?.target || null;
  }

  await clearFlowState(conversationId);
}

// ── Continuar flujo desde un botón presionado ────────────────
async function continueFlowFromButton(flowId, currentNodeId, buttonText, contactPhone, connection, conversationId) {
  try {
    const { data: flow } = await supabase
      .from('flows')
      .select('*')
      .eq('id', flowId)
      .single();

    if (!flow) return false;

    const buttonLower = buttonText.toLowerCase().trim();
    const apiNode = flow.nodes.find(n => n.id === currentNodeId);
    if (!apiNode) return false;

    const buttons = apiNode.data?.buttons || [];
    const buttonIndex = buttons.findIndex(b => {
      const btnText = (b.titulo || b.title || b || '').toLowerCase();
      return btnText === buttonLower || btnText.includes(buttonLower) || buttonLower.includes(btnText);
    });

    console.log(`[Button] Botón "${buttonText}" → índice ${buttonIndex}`);

    const edges = flow.edges || [];
    const buttonEdges = edges.filter(e => e.source === apiNode.id);

    let nextNodeId = null;
    const matchedEdge = buttonEdges.find(e =>
      e.sourceHandle === `output-btn-${buttonIndex}` ||
      e.sourceHandle === `btn-${buttonIndex}` ||
      e.sourceHandle === `btn-${buttonIndex}-out`
    );

    if (matchedEdge) {
      nextNodeId = matchedEdge.target;
    } else if (buttonEdges[buttonIndex]) {
      nextNodeId = buttonEdges[buttonIndex].target;
    } else if (buttonEdges[0]) {
      nextNodeId = buttonEdges[0].target;
    }

    if (!nextNodeId) {
      console.log('[Button] No se encontró nodo siguiente');
      return false;
    }

    console.log(`[Button] Continuando desde nodo ${nextNodeId}`);

    await clearFlowState(conversationId);

    const tempStartId = `temp-start-${Date.now()}`;
    const tempFlow = {
      ...flow,
      nodes: [
        { id: tempStartId, type: 'start', data: {} },
        ...flow.nodes
      ],
      edges: [
        { id: `temp-edge-${Date.now()}`, source: tempStartId, target: nextNodeId },
        ...flow.edges
      ]
    };

    await executeFlow(flow.id, contactPhone, buttonText, connection, conversationId, tempFlow);
    return true;
  } catch (err) {
    console.error('[Button] Error:', err.message);
    return false;
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

module.exports = {
  executeFlow,
  saveMessage,
  sendWhatsAppMessage,
  cancelFollowups,
  continueFlowFromButton,
  clearFlowState,
  runScheduler
};