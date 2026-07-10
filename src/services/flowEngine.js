const axios = require('axios');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');

const GRAPH_VERSION = 'v19.0';

// ════════════════════════════════════════════════════════════
// ENVÍO DE MENSAJES (WhatsApp Cloud API)
// ════════════════════════════════════════════════════════════

// ── Mostrar "escribiendo..." + marcar como leído (Cloud API) ──
// Meta permite mostrar el indicador de escritura junto con marcar el
// mensaje como leído. Dura hasta 25 segundos o hasta que se envíe la
// respuesta real, lo que ocurra primero.
async function showTypingCloud(phoneNumberId, accessToken, messageId) {
  if (!messageId) return;
  try {
    await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' }
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    // No es crítico si falla (ej. cuenta sin este feature habilitado aún)
    console.log('[CloudAPI] No se pudo mostrar indicador de escritura:', err.response?.data?.error?.message || err.message);
  }
}

async function sendWhatsAppMessage(phoneNumberId, accessToken, to, message, conversationId) {
  if (!message || !message.trim()) return;
  try {
    await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: message } },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    if (conversationId) await saveMessage(conversationId, message, 'outbound', 'text');
    console.log(`[CloudAPI] ✓ Texto enviado`);
  } catch (err) {
    console.error('[WhatsApp send error]', err.response?.data || err.message);
  }
}

async function sendWhatsAppButtons(phoneNumberId, accessToken, to, bodyText, buttons, conversationId) {
  try {
    await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
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
              reply: { id: `btn_${i}`, title: String(btn).slice(0, 20) }
            }))
          }
        }
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    if (conversationId) {
      const fullText = bodyText + '\n\n' + buttons.map((b, i) => `${i + 1}. ${b}`).join('\n');
      await saveMessage(conversationId, fullText, 'outbound', 'text');
    }
    console.log(`[CloudAPI] ✓ Botones enviados`);
  } catch (err) {
    console.error('[WhatsApp buttons error]', err.response?.data || err.message);
    const text = bodyText + '\n\n' + buttons.map((b, i) => `${i + 1}. ${b}`).join('\n');
    await sendWhatsAppMessage(phoneNumberId, accessToken, to, text, conversationId);
  }
}

async function sendWhatsAppImage(phoneNumberId, accessToken, to, url, caption, conversationId) {
  if (!url || url.startsWith('data:')) return;
  try {
    await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'image', image: { link: url, caption: caption || '' } },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    if (conversationId) await saveMessage(conversationId, caption || '[Imagen]', 'outbound', 'image', url);
    console.log(`[CloudAPI] ✓ Imagen enviada`);
  } catch (err) {
    console.error('[WhatsApp image error]', err.response?.data || err.message);
    if (caption) await sendWhatsAppMessage(phoneNumberId, accessToken, to, caption, conversationId);
  }
}

async function sendWhatsAppVideo(phoneNumberId, accessToken, to, url, caption, conversationId) {
  if (!url || url.startsWith('data:')) return;
  try {
    await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'video', video: { link: url, caption: caption || '' } },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    if (conversationId) await saveMessage(conversationId, caption || '[Video]', 'outbound', 'video', url);
    console.log(`[CloudAPI] ✓ Video enviado`);
  } catch (err) {
    console.error('[WhatsApp video error]', err.response?.data || err.message);
  }
}

async function sendWhatsAppAudio(phoneNumberId, accessToken, to, url, conversationId) {
  if (!url || url.startsWith('data:')) return;
  try {
    await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'audio', audio: { link: url } },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    if (conversationId) await saveMessage(conversationId, '[Audio]', 'outbound', 'audio', url);
    console.log(`[CloudAPI] ✓ Audio enviado`);
  } catch (err) {
    console.error('[WhatsApp audio error]', err.response?.data || err.message);
  }
}

async function sendWhatsAppDocument(phoneNumberId, accessToken, to, url, fileName, conversationId) {
  if (!url || url.startsWith('data:')) return;
  try {
    const nombre = fileName || url.split('/').pop().split('?')[0] || 'documento.pdf';
    await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'document', document: { link: url, filename: nombre } },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    if (conversationId) await saveMessage(conversationId, `[Documento: ${nombre}]`, 'outbound', 'document', url);
    console.log(`[CloudAPI] ✓ Documento enviado: ${nombre}`);
  } catch (err) {
    console.error('[WhatsApp document error]', err.response?.data || err.message);
  }
}

// ── Descargar media entrante (comprobantes de pago) ──────────
async function downloadWhatsAppMedia(mediaId, accessToken) {
  const metaRes = await axios.get(
    `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const mediaUrl = metaRes.data.url;
  const mediaRes = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    responseType: 'arraybuffer'
  });
  return { buffer: Buffer.from(mediaRes.data), mimeType: metaRes.data.mime_type || 'image/jpeg' };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ════════════════════════════════════════════════════════════
// BLOQUEO POR PAÍS (idéntico al de baileys.js)
// ════════════════════════════════════════════════════════════
const CALLING_CODE_TO_ISO = [
  ['1809', 'DO'], ['1829', 'DO'], ['1849', 'DO'],
  ['54', 'AR'], ['55', 'BR'], ['56', 'CL'], ['57', 'CO'], ['58', 'VE'],
  ['51', 'PE'], ['52', 'MX'], ['53', 'CU'],
  ['591', 'BO'], ['592', 'GY'], ['593', 'EC'], ['594', 'GF'], ['595', 'PY'],
  ['596', 'MQ'], ['597', 'SR'], ['598', 'UY'], ['599', 'CW'],
  ['502', 'GT'], ['503', 'SV'], ['504', 'HN'], ['505', 'NI'],
  ['506', 'CR'], ['507', 'PA'], ['501', 'BZ'],
  ['1', 'US'],
];

function getCountryCodeFromPhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  const sorted = [...CALLING_CODE_TO_ISO].sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, iso] of sorted) {
    if (digits.startsWith(prefix)) return iso;
  }
  return null;
}

async function isCountryBlocked(userId, contactPhone) {
  try {
    const iso = getCountryCodeFromPhone(contactPhone);
    if (!iso) return false;
    const { data } = await supabase
      .from('blocked_countries')
      .select('id')
      .eq('user_id', userId)
      .eq('country_code', iso)
      .maybeSingle();
    return !!data;
  } catch (err) {
    console.error('[FlowEngine] Error revisando bloqueo por país:', err.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════════
// RESPONDER CON IA (Groq — igual que en QR)
// ════════════════════════════════════════════════════════════
async function respondWithAI(userId, connection, to, userMessage, conversationId, aiConfigIdOverride = null, nodePrompt = null) {
  console.log(`[CloudAPI AI] Intentando responder con IA para user: ${userId}`);
  try {
    const { data: convData } = await supabase
      .from('conversations')
      .select('ai_config_id, active_price')
      .eq('id', conversationId)
      .single();

    let aiConfig = null;
    const preferredConfigId = aiConfigIdOverride || convData?.ai_config_id;

    if (preferredConfigId) {
      const { data: c } = await supabase.from('ai_config').select('*').eq('id', preferredConfigId).single();
      if (c) aiConfig = c;
    }
    if (!aiConfig) {
      const { data: c } = await supabase.from('ai_config').select('*').eq('user_id', userId).eq('is_active', true).single();
      if (c) aiConfig = c;
    }
    if (!aiConfig && !nodePrompt) {
      console.log('[CloudAPI AI] No hay configuración de IA ni prompt de nodo para este usuario');
      return;
    }

    let systemPrompt = nodePrompt || aiConfig?.system_prompt ||
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

    const apiKey = aiConfig?.groq_api_key || process.env.GROQ_API_KEY;
    const model = aiConfig?.model || 'llama-3.3-70b-versatile';

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model, max_tokens: 500, messages },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    const aiResponse = response.data.choices[0].message.content;
    await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, to, aiResponse, conversationId);
  } catch (err) {
    console.error('[CloudAPI AI] Error:', err.response?.data || err.message);
  }
}

// ── Clasifica la respuesta del cliente contra los caminos usando IA ──
async function classifyResponseWithAI(userResponse, paths, aiConfigId) {
  try {
    let aiConfig = null;
    if (aiConfigId) {
      const { data: c } = await supabase.from('ai_config').select('*').eq('id', aiConfigId).single();
      if (c) aiConfig = c;
    }
    const apiKey = aiConfig?.groq_api_key || process.env.GROQ_API_KEY;
    const model = aiConfig?.model || 'llama-3.3-70b-versatile';
    const options = paths.map((p, i) => `${i}: ${p.label}`).join('\n');

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model,
        max_tokens: 10,
        messages: [
          {
            role: 'system',
            content: `Eres un clasificador. Dado un mensaje de un cliente, decide a cuál de estas opciones corresponde mejor:\n${options}\n\nResponde SOLO con el número de la opción (ej: "0"), sin texto adicional. Si el mensaje no corresponde claramente a ninguna opción, responde "-1".`
          },
          { role: 'user', content: userResponse }
        ]
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    const raw = response.data.choices[0].message.content.trim();
    const idx = parseInt(raw.match(/-?\d+/)?.[0] ?? '-1', 10);
    return (idx >= 0 && idx < paths.length) ? idx : -1;
  } catch (err) {
    console.error('[CloudAPI] Error clasificando camino con IA:', err.message);
    return -1;
  }
}

// ════════════════════════════════════════════════════════════
// MOTOR DE FLUJOS — ejecuta nodo por nodo
// ════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════
// PROGRAMAR/ENVIAR LOS SEGUIMIENTOS DE UN NODO "Seguimiento"
// ════════════════════════════════════════════════════════════
async function scheduleSeguimientos(followupNode, connection, phoneNumberId, accessToken, to, contactPhone, conversationId) {
  const seguimientos = followupNode.data?.seguimientos || [];
  for (const seg of seguimientos) {
    const minutos = seg.tiempo_minutos || 0;
    const precio = seg.precio || '';
    if (minutos > 0) {
      const sendAt = new Date(Date.now() + minutos * 60 * 1000).toISOString();
      await supabase.from('scheduled_followups').insert({
        id: uuidv4(),
        conversation_id: conversationId,
        connection_id: connection.id,
        contact_phone: contactPhone,
        seg_data: seg,
        status: 'pending',
        send_at: sendAt,
        created_at: new Date().toISOString()
      });
      console.log(`[Flow] Seguimiento programado para ${minutos} min (conexión: ${connection.id})`);
    } else {
      if (precio) {
        await supabase.from('conversations').update({ active_price: precio }).eq('id', conversationId);
      }
      for (const contenido of seg.contenidos || []) {
        await sendFollowupContentCloud(phoneNumberId, accessToken, to, contenido, conversationId);
      }
    }
  }
}

// ════════════════════════════════════════════════════════════
// BUSCAR Y PROGRAMAR SEGUIMIENTOS "ADJUNTOS" A UN NODO QUE SE PAUSA
// (mismo mecanismo que en baileys.js — edge especial 'seguimiento-out')
// ════════════════════════════════════════════════════════════
async function scheduleAttachedFollowups(flow, nodeId, connection, phoneNumberId, accessToken, to, contactPhone, conversationId) {
  const nodeMap = {};
  (flow.nodes || []).forEach(n => { nodeMap[n.id] = n; });

  const attachedEdges = (flow.edges || []).filter(
    e => e.target === nodeId && e.sourceHandle === 'seguimiento-out'
  );

  for (const edge of attachedEdges) {
    const followupNode = nodeMap[edge.source];
    if (followupNode && (followupNode.type === 'followup' || followupNode.type === 'delay_followup')) {
      console.log(`[Flow] Seguimiento adjunto encontrado (${followupNode.id}) para nodo pausado ${nodeId}`);
      await scheduleSeguimientos(followupNode, connection, phoneNumberId, accessToken, to, contactPhone, conversationId);
    }
  }
}

async function executeFlow(flowId, contactPhone, userMessage, connection, conversationId, startNodeId = null) {
  const { data: flow } = await supabase.from('flows').select('*').eq('id', flowId).single();
  if (!flow || !flow.nodes?.length) return;

  const nodeMap = {};
  flow.nodes.forEach(n => { nodeMap[n.id] = n; });

  const edgeMap = {};
  (flow.edges || []).forEach(e => {
    if (!edgeMap[e.source]) edgeMap[e.source] = [];
    edgeMap[e.source].push(e.target);
  });

  let currentNodeId;
  if (startNodeId) {
    currentNodeId = startNodeId;
  } else {
    const startNode = flow.nodes.find(n => n.type === 'start' || n.type === 'trigger');
    if (!startNode) return;
    currentNodeId = edgeMap[startNode.id]?.[0];
  }

  const to = contactPhone;
  const phoneNumberId = connection.phone_number_id;
  const accessToken = connection.access_token;
  let shouldPause = false;

  while (currentNodeId && !shouldPause) {
    const node = nodeMap[currentNodeId];
    if (!node) break;

    console.log(`[Flow] Ejecutando nodo: ${node.type} (${node.id})`);

    switch (node.type) {

      // ── Contenido (texto/imagen/video/audio/doc/intervalo) ──
      case 'message':
      case 'content': {
        const items = node.data?.items || [];

        if (items.length === 0) {
          const legacyText = node.data?.text || node.data?.content || '';
          if (legacyText) await sendWhatsAppMessage(phoneNumberId, accessToken, to, legacyText, conversationId);
        }

        for (const item of items) {
          const tipo = (item.type || '').toLowerCase();
          if (tipo === 'interval') {
            await sleep(Math.min(item.seconds || 1, 30) * 1000);
            continue;
          }
          if (tipo === 'text' || tipo === 'texto') {
            const text = item.text || item.content || '';
            if (text) await sendWhatsAppMessage(phoneNumberId, accessToken, to, text, conversationId);
          } else if (tipo === 'image' || tipo === 'imagen') {
            await sendWhatsAppImage(phoneNumberId, accessToken, to, item.url || '', item.caption || '', conversationId);
          } else if (tipo === 'video') {
            await sendWhatsAppVideo(phoneNumberId, accessToken, to, item.url || '', item.caption || item.description || '', conversationId);
          } else if (tipo === 'audio') {
            await sendWhatsAppAudio(phoneNumberId, accessToken, to, item.url || '', conversationId);
          } else if (tipo === 'doc' || tipo === 'document' || tipo === 'documento') {
            await sendWhatsAppDocument(phoneNumberId, accessToken, to, item.url || '', item.fileName || item.name || '', conversationId);
          }
          await sleep(500);
        }

        if (node.data?.esperarRespuesta) {
          await supabase.from('conversations').update({
            current_flow_id: flowId, current_node_id: node.id, flow_active: true
          }).eq('id', conversationId);
          console.log(`[Flow] ⏸ Pausado en ${node.id} (texto) esperando respuesta`);
          await scheduleAttachedFollowups(flow, node.id, connection, phoneNumberId, accessToken, to, contactPhone, conversationId);
          shouldPause = true;
        }
        break;
      }

      // ── Botones reales de WhatsApp API ──────────────────────
      case 'api':
      case 'buttons':
      case 'api_message': {
        const text = node.data?.body || node.data?.text || '';
        const buttons = node.data?.buttons || [];
        const headerImage = node.data?.headerType === 'Imagen' ? (node.data?.headerImage || '') : '';

        if (headerImage) {
          await sendWhatsAppImage(phoneNumberId, accessToken, to, headerImage, '', conversationId);
          await sleep(600);
        }

        if (buttons.length > 0) {
          await sendWhatsAppButtons(phoneNumberId, accessToken, to, text, buttons, conversationId);
          await supabase.from('conversations').update({
            current_flow_id: flowId, current_node_id: node.id, flow_active: true
          }).eq('id', conversationId);
          console.log(`[Flow] ⏸ Pausado en ${node.id} esperando selección de botón`);
          await scheduleAttachedFollowups(flow, node.id, connection, phoneNumberId, accessToken, to, contactPhone, conversationId);
          shouldPause = true;
        } else if (text) {
          await sendWhatsAppMessage(phoneNumberId, accessToken, to, text, conversationId);
        }
        break;
      }

      // ── Agente IA (con caminos de ruteo, igual que QR) ─────
      case 'ai':
      case 'ai_agent': {
        const paths = node.data?.paths || [];
        // Si tiene caminos configurados, solo espera en silencio y
        // analiza la respuesta del cliente cuando llegue — el mensaje
        // ya lo dijo el nodo anterior.
        const tieneCaminos = paths.length > 0;

        if (!tieneCaminos) {
          await respondWithAI(connection.user_id, connection, to, userMessage, conversationId, node.data?.ai_config_id, node.data?.context);
        } else {
          console.log(`[Flow] ${node.id} tiene caminos — se pausa en silencio, sin generar mensaje al llegar`);
        }

        if (tieneCaminos) {
          await supabase.from('conversations').update({
            current_flow_id: flowId, current_node_id: node.id, flow_active: true
          }).eq('id', conversationId);
          console.log(`[Flow] ⏸ Pausado en ${node.id} (Agente IA) esperando respuesta para elegir camino`);
          await scheduleAttachedFollowups(flow, node.id, connection, phoneNumberId, accessToken, to, contactPhone, conversationId);
          shouldPause = true;
        }
        break;
      }

      // ── Condición / bifurcación ────────────────────────────
      case 'condition': {
        const variable = node.data?.variable || 'message';
        const operator = node.data?.operator || 'contains';
        const value = (node.data?.value || '').toLowerCase();
        const checkText = (userMessage || '').toLowerCase();

        let conditionMet = false;
        if (operator === 'contains') conditionMet = checkText.includes(value);
        else if (operator === 'equals') conditionMet = checkText === value;
        else if (operator === 'starts_with') conditionMet = checkText.startsWith(value);
        else if (operator === 'not_contains') conditionMet = !checkText.includes(value);

        const edges = (flow.edges || []).filter(e => e.source === currentNodeId);
        const yesEdge = edges.find(e => e.sourceHandle === 'yes' || e.label === 'sí');
        const noEdge = edges.find(e => e.sourceHandle === 'no' || e.label === 'no');
        const nextEdge = conditionMet ? yesEdge : noEdge;
        currentNodeId = nextEdge?.target || null;
        continue;
      }

      // ── Delay / espera ────────────────────────────────────
      case 'delay': {
        const seconds = node.data?.seconds || 3;
        await sleep(Math.min(seconds * 1000, 30000));
        break;
      }

      // ── Seguimiento (igual que QR: programa o envía inmediato) ──
      case 'followup':
      case 'delay_followup': {
        await scheduleSeguimientos(node, connection, phoneNumberId, accessToken, to, contactPhone, conversationId);
        break;
      }

      // ── Etiqueta (tag al contacto) ─────────────────────────
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

      // ── Notificación (aviso interno) ───────────────────────
      case 'notification':
      case 'notify': {
        const notifyPhone = (node.data?.phone || '').replace(/\D/g, '');
        const msg = (node.data?.message || 'Nueva conversación: {{phone}}').replace('{{phone}}', contactPhone);
        if (notifyPhone && msg) {
          await sendWhatsAppMessage(phoneNumberId, accessToken, notifyPhone, msg, null);
        }
        break;
      }

      // ── Activar otro flujo ─────────────────────────────────
      case 'activate_flow':
      case 'trigger_flow': {
        const targetFlowId = node.data?.flowId || node.data?.flow_id;
        if (targetFlowId) {
          const { data: targetFlow } = await supabase.from('flows').select('nodes').eq('id', targetFlowId).single();
          const startNode = (targetFlow?.nodes || []).find(n => n.type === 'start');
          if (startNode) {
            await executeFlow(targetFlowId, contactPhone, userMessage, connection, conversationId, startNode.id);
          }
        }
        currentNodeId = null;
        continue;
      }

      // ── Fin del flujo ──────────────────────────────────────
      case 'end':
        currentNodeId = null;
        continue;
    }

    if (shouldPause) break;
    currentNodeId = edgeMap[currentNodeId]?.[0] || null;
  }
}

// ── Enviar contenido de seguimiento (Cloud API) ──────────────
async function sendFollowupContentCloud(phoneNumberId, accessToken, to, contenido, conversationId) {
  const tipo = (contenido.tipo || '').toLowerCase();

  if (tipo === 'texto') {
    await sendWhatsAppMessage(phoneNumberId, accessToken, to, contenido.texto || contenido.mensaje || '', conversationId);
  } else if (tipo === 'imagen') {
    await sendWhatsAppImage(phoneNumberId, accessToken, to, contenido.url || '', contenido.caption || contenido.descripcion || '', conversationId);
  } else if (tipo === 'pausa') {
    await sleep((contenido.segundos || 1) * 1000);
  } else if (tipo === 'botones') {
    if (contenido.imagen_cabecera) {
      await sendWhatsAppImage(phoneNumberId, accessToken, to, contenido.imagen_cabecera, '', conversationId);
      await sleep(600);
    }
    const botones = contenido.botones || [];
    if (botones.length > 0) {
      await sendWhatsAppButtons(phoneNumberId, accessToken, to, contenido.mensaje || '', botones, conversationId);
    } else if (contenido.mensaje) {
      await sendWhatsAppMessage(phoneNumberId, accessToken, to, contenido.mensaje, conversationId);
    }
  } else if (tipo === 'audio') {
    await sendWhatsAppAudio(phoneNumberId, accessToken, to, contenido.url || '', conversationId);
  } else if (tipo === 'video') {
    await sendWhatsAppVideo(phoneNumberId, accessToken, to, contenido.url || '', contenido.caption || contenido.descripcion || '', conversationId);
  } else if (tipo === 'archivo' || tipo === 'documento' || tipo === 'doc') {
    await sendWhatsAppDocument(phoneNumberId, accessToken, to, contenido.url || '', contenido.fileName || contenido.nombre || '', conversationId);
  }

  await sleep(400);
}

// ════════════════════════════════════════════════════════════
// RESOLVER NODO "AGENTE IA" PAUSADO CON CAMINO "PAGO"
// ════════════════════════════════════════════════════════════
async function resolvePaidPathNode(conversation) {
  if (!conversation?.current_flow_id || !conversation?.current_node_id) return null;

  const { data: flow } = await supabase
    .from('flows')
    .select('id, nodes, edges')
    .eq('id', conversation.current_flow_id)
    .single();

  if (!flow) return null;

  const node = (flow.nodes || []).find(n => n.id === conversation.current_node_id);
  if (!node || (node.type !== 'ai' && node.type !== 'ai_agent')) return null;

  const paths = node.data?.paths || [];
  const paidPaths = paths.map((p, index) => ({ path: p, index })).filter(p => p.path.type === 'Pago');
  if (paidPaths.length === 0) return null;

  return { flow, node, paidPaths };
}

// ════════════════════════════════════════════════════════════
// PROCESAR IMAGEN ENTRANTE (comprobante de pago) — Cloud API
// ════════════════════════════════════════════════════════════
async function processIncomingImageCloud(connection, contactPhone, mediaId, conversationId) {
  const userId = connection.user_id;
  const phoneNumberId = connection.phone_number_id;
  const accessToken = connection.access_token;
  const to = contactPhone;

  const { data: conversation } = await supabase.from('conversations').select('*').eq('id', conversationId).single();
  if (!conversation) return;

  if (conversation.is_blocked) return;

  let imageBuffer = null, mimeType = 'image/jpeg';
  try {
    const media = await downloadWhatsAppMedia(mediaId, accessToken);
    imageBuffer = media.buffer;
    mimeType = media.mimeType;
  } catch (err) {
    console.error('[CloudAPI Payment] Error descargando imagen:', err.response?.data || err.message);
  }

  let publicMediaUrl = null;
  if (imageBuffer) {
    try {
      const ext = (mimeType.split('/')[1] || 'jpg').split(';')[0];
      const filePath = `${userId}/${conversation.id}/${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage.from('media').upload(filePath, imageBuffer, { contentType: mimeType, upsert: false });
      if (!uploadError) {
        const { data: publicUrlData } = supabase.storage.from('media').getPublicUrl(filePath);
        publicMediaUrl = publicUrlData?.publicUrl || null;
      }
    } catch (upErr) {
      console.error('[CloudAPI Payment] Error subiendo imagen a Storage:', upErr.message);
    }
  }

  await saveMessage(conversation.id, '[Imagen recibida - posible comprobante]', 'inbound', 'image', publicMediaUrl);

  if (conversation.flow_active === false) return;
  if (!imageBuffer) return;

  const base64Image = imageBuffer.toString('base64');
  const paidPathInfo = await resolvePaidPathNode(conversation);

  const { data: paymentConfig } = await supabase.from('payment_config').select('*').eq('user_id', userId).single();
  const msgConfirmacion = paymentConfig?.msg_confirmacion || 'Gracias por tu pago. Validaremos el comprobante y en breve te enviaremos el acceso.';
  const msgNoValido = paymentConfig?.msg_no_valido || 'Disculpa, no pudimos validar el comprobante. Por favor envía una foto más clara.';

  const apiKey = process.env.GROQ_API_KEY;
  const hoyLima = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const validarExtra = (paidPathInfo?.paidPaths || []).map(p => p.path.validar).filter(Boolean)[0];

  let analysisResult = null;
  try {
    const visionResponse = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analiza esta imagen. ¿Es un comprobante de pago (Yape, Plin, transferencia bancaria u otro)?
Si lo es, extrae:
- monto: el monto exacto pagado (solo el número, sin moneda)
- titular_destino: el nombre del destinatario/titular al que se realizó el pago
- numero_operacion: el número de operación/transacción, si aparece
- fecha_es_hoy: true si la fecha del comprobante es hoy (${hoyLima}, zona horaria Perú), false si es anterior, null si no se ve
- estado_pago: "confirmado" si el pago está exitoso/completado, "pendiente" si está en proceso, "desconocido" si no es claro
${validarExtra ? `- cumple_validacion_extra: true/false según si cumple: "${validarExtra}"` : ''}

Responde SOLO en formato JSON exacto:
{"es_comprobante": true/false, "monto": numero_o_null, "titular_destino": "nombre_o_null", "numero_operacion": "texto_o_null", "fecha_es_hoy": true/false/null, "estado_pago": "confirmado/pendiente/desconocido"${validarExtra ? ', "cumple_validacion_extra": true/false' : ''}}`
            },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
          ]
        }]
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );
    const rawText = visionResponse.data.choices[0].message.content.trim();
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) analysisResult = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[CloudAPI Payment Vision error]', err.response?.data || err.message);
  }

  if (!analysisResult || !analysisResult.es_comprobante) {
    await sendWhatsAppMessage(phoneNumberId, accessToken, to, msgNoValido, conversation.id);
    return;
  }

  const monto = analysisResult.monto;

  if (paidPathInfo && paidPathInfo.paidPaths.length > 0) {
    let selected = paidPathInfo.paidPaths[0];
    if (paidPathInfo.paidPaths.length > 1 && monto !== null && monto !== undefined) {
      const match = paidPathInfo.paidPaths.find(p => {
        const esperado = parseFloat(p.path.monto);
        return !isNaN(esperado) && Math.abs(parseFloat(monto) - esperado) <= 0.01;
      });
      if (match) selected = match;
    }

    const { path } = selected;
    const fallas = [];

    if (path.monto) {
      const esperado = parseFloat(path.monto);
      if (!isNaN(esperado) && (monto === null || monto === undefined || Math.abs(parseFloat(monto) - esperado) > 0.01)) {
        fallas.push(`el monto no coincide (esperado S/${esperado}, recibido ${monto ?? 'no detectado'})`);
      }
    }
    if (path.nombre) {
      const esperado = path.nombre.toLowerCase().trim();
      const detectado = (analysisResult.titular_destino || '').toLowerCase().trim();
      if (!detectado || (!detectado.includes(esperado) && !esperado.includes(detectado))) {
        fallas.push('el titular del comprobante no coincide con el esperado');
      }
    }
    if (path.confirmado === true && analysisResult.estado_pago !== 'confirmado') {
      fallas.push('el comprobante no muestra un pago confirmado/exitoso');
    }
    if (path.fecha === true && analysisResult.fecha_es_hoy !== true) {
      fallas.push('la fecha del comprobante no es de hoy (posible captura antigua o reutilizada)');
    }
    if (validarExtra && path.validar && analysisResult.cumple_validacion_extra !== true) {
      fallas.push(`no cumple con el criterio adicional configurado: "${path.validar}"`);
    }

    let reusado = false;
    if (path.reuso === true && analysisResult.numero_operacion) {
      try {
        const { data: existente } = await supabase.from('used_payment_operations').select('id')
          .eq('user_id', userId).eq('numero_operacion', analysisResult.numero_operacion).maybeSingle();
        if (existente) { reusado = true; fallas.push('este comprobante ya fue usado anteriormente (número de operación repetido)'); }
      } catch (err) {
        console.log('[CloudAPI Payment] Tabla used_payment_operations no disponible:', err.message);
      }
    }

    if (fallas.length > 0) {
      console.log(`[CloudAPI Payment] Validación falló: ${fallas.join(' | ')}`);
      if (paidPathInfo.node?.data?.respondIfNoMatch !== false) {
        const contexto = `El cliente envió un comprobante de pago, pero la validación falló por: ${fallas.join('; ')}. Explícale amablemente por qué no se pudo validar y qué debe hacer.`;
        await respondWithAI(userId, connection, to, contexto, conversation.id, paidPathInfo.node?.data?.ai_config_id, paidPathInfo.node?.data?.context);
      }
      return;
    }

    await sendWhatsAppMessage(phoneNumberId, accessToken, to, msgConfirmacion, conversation.id);

    if (path.reuso === true && analysisResult.numero_operacion && !reusado) {
      try {
        await supabase.from('used_payment_operations').insert({ user_id: userId, numero_operacion: analysisResult.numero_operacion, conversation_id: conversation.id });
      } catch (err) {
        console.log('[CloudAPI Payment] No se pudo registrar número de operación:', err.message);
      }
    }

    const matchedHandle = `path-${selected.index}`;
    let matchedEdge = (paidPathInfo.flow.edges || []).find(e => e.source === paidPathInfo.node.id && e.sourceHandle === matchedHandle);

    if (!matchedEdge && (paidPathInfo.node.data?.paths || []).length === 1) {
      const edgesFromNode = (paidPathInfo.flow.edges || []).filter(e => e.source === paidPathInfo.node.id);
      if (edgesFromNode.length === 1) {
        console.log(`[CloudAPI Payment] Usando respaldo: nodo con un solo camino, edge sin sourceHandle etiquetado`);
        matchedEdge = edgesFromNode[0];
      }
    }

    await supabase.from('conversations').update({
      is_sale: true, sale_amount: monto, sale_at: new Date().toISOString(),
      current_node_id: null, current_flow_id: null
    }).eq('id', conversation.id);

    try { await cancelFollowups(conversation.id); } catch (e) { console.error('[CloudAPI Payment] Error cancelando seguimientos:', e.message); }

    if (matchedEdge) {
      await executeFlow(paidPathInfo.flow.id, contactPhone, '', connection, conversation.id, matchedEdge.target);
    }
    return;
  }

  // ── Camino legado (sin flujo pausado) ──
  if (monto === null || monto === undefined) {
    await sendWhatsAppMessage(phoneNumberId, accessToken, to, msgConfirmacion, conversation.id);
    return;
  }

  const titularEsperadoLegado = (paymentConfig?.titular || '').toLowerCase().trim();
  if (titularEsperadoLegado) {
    const titularDetectado = (analysisResult.titular_destino || '').toLowerCase().trim();
    if (titularDetectado && !titularDetectado.includes(titularEsperadoLegado) && !titularEsperadoLegado.includes(titularDetectado)) {
      await sendWhatsAppMessage(phoneNumberId, accessToken, to, 'Disculpa, el comprobante no está dirigido a nuestra cuenta. Por favor verifica el destinatario e intenta de nuevo.', conversation.id);
      return;
    }
  }

  await sendWhatsAppMessage(phoneNumberId, accessToken, to, msgConfirmacion, conversation.id);

  const { data: rules } = await supabase.from('payment_rules').select('*').eq('user_id', userId).eq('is_active', true);
  const matchedRule = await findMatchingPaymentRule(rules, monto, conversation.id);
  if (!matchedRule) return;

  await sendWhatsAppMessage(phoneNumberId, accessToken, to, matchedRule.access_message, conversation.id);
  await supabase.from('conversations').update({ is_sale: true, sale_amount: monto, sale_at: new Date().toISOString(), flow_active: false }).eq('id', conversation.id);
  try { await cancelFollowups(conversation.id); } catch (e) { console.error('[CloudAPI Payment] Error cancelando seguimientos:', e.message); }
}

async function findMatchingPaymentRule(rules, monto, conversationId) {
  const candidates = (rules || []).filter(r => Math.abs(Number(r.amount) - Number(monto)) < 0.5);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const { data: history } = await supabase.from('messages').select('content').eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(20);
  const recentText = (history || []).map(m => m.content || '').join(' ').toLowerCase();

  for (const rule of candidates) {
    if (rule.context_keyword && recentText.includes(rule.context_keyword.toLowerCase())) return rule;
  }
  return candidates[0];
}

// ════════════════════════════════════════════════════════════
// RESOLVER CAMINO DE TEXTO DE UN NODO "AGENTE IA"
// ════════════════════════════════════════════════════════════
async function resolveAIPath(flow, pausedNode, paths, userResponse, connection, contactPhone, conversationId) {
  const pausedNodeId = pausedNode.id;
  const normalizedResponse = userResponse.toLowerCase().replace(/[^a-z0-9áéíóúñ ]/g, '').trim();

  // Un camino tipo "Pago" solo puede cumplirse con una imagen de
  // comprobante, nunca con texto — se excluye de este matching.
  const textPaths = paths
    .map((p, originalIndex) => ({ ...p, originalIndex }))
    .filter(p => p.type !== 'Pago');

  let matched = textPaths.find(p => {
    const label = (p.label || '').toLowerCase().replace(/[^a-z0-9áéíóúñ ]/g, '').trim();
    return label && (normalizedResponse.includes(label) || label.includes(normalizedResponse));
  });

  if (!matched && textPaths.length > 0) {
    const idx = await classifyResponseWithAI(userResponse, textPaths, pausedNode.data?.ai_config_id);
    if (idx !== -1) matched = textPaths[idx];
  }

  if (!matched) {
    if (pausedNode.data?.respondIfNoMatch !== false) {
      await respondWithAI(connection.user_id, connection, contactPhone, userResponse, conversationId, pausedNode.data?.ai_config_id, pausedNode.data?.context);
    }
    return true;
  }

  const matchedIndex = matched.originalIndex;
  const matchedHandle = `path-${matchedIndex}`;
  let matchedEdge = (flow.edges || []).find(e => e.source === pausedNodeId && e.sourceHandle === matchedHandle);

  if (!matchedEdge && textPaths.length === 1) {
    const edgesFromNode = (flow.edges || []).filter(e => e.source === pausedNodeId);
    if (edgesFromNode.length === 1) {
      console.log(`[Flow] Usando respaldo: nodo con un solo camino, edge sin sourceHandle etiquetado`);
      matchedEdge = edgesFromNode[0];
    }
  }

  if (!matchedEdge) {
    console.log(`[Flow] ⚠️ Camino "${matchedHandle}" (${matched.label}) no tiene edge conectado en el editor — revisa esa conexión en el flujo. Respondiendo con IA para no dejar al cliente sin respuesta.`);
    await respondWithAI(connection.user_id, connection, contactPhone, userResponse, conversationId, pausedNode.data?.ai_config_id, pausedNode.data?.context);
    return true;
  }

  await supabase.from('conversations').update({ current_node_id: null, current_flow_id: null }).eq('id', conversationId);
  try { await cancelFollowups(conversationId); } catch (e) { console.error('[Flow] Error cancelando seguimientos:', e.message); }
  await executeFlow(flow.id, contactPhone, userResponse, connection, conversationId, matchedEdge.target);
  return true;
}

// ════════════════════════════════════════════════════════════
// CONTINUAR FLUJO PAUSADO (botón / texto libre / camino IA)
// ════════════════════════════════════════════════════════════
async function continueFlowFromButton(flowId, pausedNodeId, userResponse, connection, contactPhone, conversationId) {
  const { data: flow } = await supabase.from('flows').select('id, nodes, edges').eq('id', flowId).single();
  if (!flow) return false;

  const nodeMap = {};
  flow.nodes.forEach(n => { nodeMap[n.id] = n; });
  const pausedNode = nodeMap[pausedNodeId];
  if (!pausedNode) return false;

  if (pausedNode.type === 'ai' || pausedNode.type === 'ai_agent') {
    const paths = pausedNode.data?.paths || [];
    if (paths.length > 0) {
      return await resolveAIPath(flow, pausedNode, paths, userResponse, connection, contactPhone, conversationId);
    }
  }

  if (pausedNode.type !== 'buttons' && pausedNode.type !== 'api_message' && pausedNode.type !== 'api') {
    const nextEdges = (flow.edges || []).filter(e => e.source === pausedNodeId);
    const nextEdge = nextEdges.find(e => !e.sourceHandle || e.sourceHandle === 'default') || nextEdges[0];
    if (!nextEdge) return false;

    await supabase.from('conversations').update({ current_node_id: null, current_flow_id: null }).eq('id', conversationId);
    try { await cancelFollowups(conversationId); } catch (e) { console.error('[Flow] Error cancelando seguimientos:', e.message); }
    await executeFlow(flowId, contactPhone, userResponse, connection, conversationId, nextEdge.target);
    return true;
  }

  const buttons = pausedNode.data?.buttons || [];
  const normalizedResponse = userResponse.toLowerCase().trim();

  let matchedIndex = -1;
  const numMatch = normalizedResponse.match(/^(\d+)/);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10) - 1;
    if (num >= 0 && num < buttons.length) matchedIndex = num;
  }
  if (matchedIndex === -1) {
    matchedIndex = buttons.findIndex(b => {
      const label = String(b).toLowerCase().replace(/[^a-z0-9áéíóúñ ]/g, '').trim();
      const resp = normalizedResponse.replace(/[^a-z0-9áéíóúñ ]/g, '').trim();
      return label && (resp.includes(label) || label.includes(resp));
    });
  }

  if (matchedIndex === -1) return false;

  const matchedHandle = `btn_${matchedIndex}`;
  let matchedEdge = (flow.edges || []).find(e => e.source === pausedNodeId && e.sourceHandle === matchedHandle);

  if (!matchedEdge && buttons.length === 1) {
    const edgesFromNode = (flow.edges || []).filter(e => e.source === pausedNodeId);
    if (edgesFromNode.length === 1) {
      console.log(`[Flow] Usando respaldo: nodo con un solo botón, edge sin sourceHandle etiquetado`);
      matchedEdge = edgesFromNode[0];
    }
  }
  if (!matchedEdge) {
    console.log(`[Flow] ⚠️ Botón "${buttons[matchedIndex]}" no tiene edge conectado en el editor — revisa esa conexión en el flujo. Respondiendo con IA para no dejar al cliente sin respuesta.`);
    await respondWithAI(connection.user_id, connection, contactPhone, userResponse, conversationId, pausedNode.data?.ai_config_id, pausedNode.data?.context);
    return true;
  }

  await supabase.from('conversations').update({ current_node_id: null, current_flow_id: null }).eq('id', conversationId);
  try { await cancelFollowups(conversationId); } catch (e) { console.error('[Flow] Error cancelando seguimientos:', e.message); }
  await executeFlow(flowId, contactPhone, userResponse, connection, conversationId, matchedEdge.target);
  return true;
}

// ════════════════════════════════════════════════════════════
// REVISAR SI OTRO TRIGGER APLICA ("Activar otros flujos")
// ════════════════════════════════════════════════════════════
async function checkOtherFlowTrigger(userId, connectionId, contactPhone, userMessage) {
  const normalizedMsg = (userMessage || '').toLowerCase().trim();
  if (!normalizedMsg) return null;

  const { data: triggers } = await supabase.from('triggers').select('*').eq('user_id', userId).eq('connection_id', connectionId).eq('is_active', true);

  const matched = (triggers || []).find(t => {
    const kw = (t.keyword || '').toLowerCase().trim();
    return kw && (normalizedMsg === kw || normalizedMsg.includes(kw));
  });
  if (!matched) return null;

  if (!matched.is_repeatable) {
    const { count } = await supabase.from('trigger_executions').select('*', { count: 'exact', head: true }).eq('trigger_id', matched.id).eq('contact_phone', contactPhone);
    if (count > 0) return null;
  }
  return matched;
}

// ── Cancelar seguimientos pendientes ──────────────────────────
async function cancelFollowups(conversationId) {
  try {
    await supabase.from('scheduled_followups').update({ status: 'cancelled' }).eq('conversation_id', conversationId).eq('status', 'pending');
  } catch (err) {
    console.error('[FlowEngine] Error cancelando seguimientos:', err.message);
  }
}

// ── Guardar mensaje en DB ──────────────────────────────────────
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
  isCountryBlocked,
  checkOtherFlowTrigger,
  continueFlowFromButton,
  processIncomingImageCloud,
  respondWithAI,
  showTypingCloud,
  sendFollowupContentCloud
};
