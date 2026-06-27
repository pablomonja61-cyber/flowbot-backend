const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const supabase = require('../models/supabase');
const { cancelFollowups } = require('./flowEngine');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Mapa de sesiones activas en memoria
const activeSessions = {};

function getSessionPath(connectionId) {
  const dir = path.join('/tmp', 'baileys_sessions', connectionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, Math.min(ms, 30000)));
}

// ── Enviar mensaje de texto ──────────────────────────────────
async function sendText(sock, jid, text, conversationId) {
  try {
    await sock.sendMessage(jid, { text });
    await saveMsg(conversationId, text, 'outbound', 'text');
    console.log(`[Baileys] Texto enviado: ${text.slice(0, 60)}`);
  } catch (e) {
    console.error('[Baileys] Error enviando texto:', e.message);
  }
}

// ── Enviar imagen ────────────────────────────────────────────
async function sendImage(sock, jid, url, caption, conversationId) {
  if (!url) return;
  try {
    await sock.sendMessage(jid, { image: { url }, caption: caption || '' });
    await saveMsg(conversationId, caption || '[Imagen]', 'outbound', 'image', url);
    console.log(`[Baileys] Imagen enviada`);
  } catch (e) {
    console.error('[Baileys] Error enviando imagen:', e.message);
    if (caption) await sendText(sock, jid, caption, conversationId);
  }
}

// ── Guardar mensaje en Supabase ──────────────────────────────
async function saveMsg(conversationId, content, direction, msgType = 'text', mediaUrl = null) {
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
    last_message_at: new Date().toISOString()
  }).eq('id', conversationId);
}

// ════════════════════════════════════════════════════════════
// MOTOR DE FLUJO PARA BAILEYS
// Ejecuta nodos y pausa en botones esperando respuesta
// ════════════════════════════════════════════════════════════
async function executeFlowBaileys(flowId, sock, jid, contactPhone, userMessage, conversationId, startNodeId = null) {
  const { data: flow } = await supabase.from('flows').select('*').eq('id', flowId).single();
  if (!flow?.nodes?.length) return;

  const nodeMap = {};
  flow.nodes.forEach(n => { nodeMap[n.id] = n; });

  // Construir mapa de edges: source -> [{ target, sourceHandle }]
  const edgeMap = {};
  (flow.edges || []).forEach(e => {
    if (!edgeMap[e.source]) edgeMap[e.source] = [];
    edgeMap[e.source].push({ target: e.target, handle: e.sourceHandle || 'default' });
  });

  // Determinar nodo inicial
  let currentNodeId = startNodeId;
  if (!currentNodeId) {
    const startNode = flow.nodes.find(n => n.type === 'start' || n.type === 'trigger');
    if (!startNode) return;
    currentNodeId = edgeMap[startNode.id]?.[0]?.target;
  }

  while (currentNodeId) {
    const node = nodeMap[currentNodeId];
    if (!node) break;

    console.log(`[Baileys Flow] Nodo: ${node.type} (${currentNodeId})`);

    switch (node.type) {

      // ── Contenido (texto, imagen, video, audio, pausa) ────
      case 'message':
      case 'content': {
        const items = node.data?.items || [];
        for (const item of items) {
          const tipo = (item.type || '').toLowerCase();

          if (tipo === 'text' || tipo === 'texto') {
            const text = item.text || item.content || '';
            if (text) await sendText(sock, jid, text, conversationId);

          } else if (tipo === 'image' || tipo === 'imagen') {
            await sendImage(sock, jid, item.url || '', item.caption || '', conversationId);

          } else if (tipo === 'video') {
            if (item.url) {
              try {
                await sock.sendMessage(jid, { video: { url: item.url }, caption: item.caption || '' });
                await saveMsg(conversationId, item.caption || '[Video]', 'outbound', 'video', item.url);
              } catch (e) {
                console.error('[Baileys] Error enviando video:', e.message);
              }
            }

          } else if (tipo === 'audio') {
            if (item.url) {
              try {
                await sock.sendMessage(jid, { audio: { url: item.url }, mimetype: 'audio/mp4' });
                await saveMsg(conversationId, '[Audio]', 'outbound', 'audio', item.url);
              } catch (e) {
                console.error('[Baileys] Error enviando audio:', e.message);
              }
            }

          } else if (tipo === 'interval') {
            const seconds = item.seconds || 1;
            console.log(`[Baileys Flow] Pausa de ${seconds} segundos`);
            await sleep(seconds * 1000);
            continue; // no agregar delay extra
          }

          await sleep(600);
        }
        break;
      }

      // ── Mensajes API con botones ──────────────────────────
      case 'api':
      case 'buttons':
      case 'api_message': {
        const text = node.data?.body || node.data?.text || '';
        const buttons = node.data?.buttons || [];
        const headerImage = node.data?.headerType === 'Imagen' ? (node.data?.headerImage || '') : '';

        // Enviar imagen de cabecera si existe
        if (headerImage) {
          await sendImage(sock, jid, headerImage, '', conversationId);
          await sleep(800);
        }

        // Enviar texto con opciones numeradas
        let fullText = text;
        if (buttons.length > 0) {
          fullText += '\n\n' + buttons.map((b, i) => `${i + 1}. ${b}`).join('\n');
        }
        if (fullText) {
          await sendText(sock, jid, fullText, conversationId);
        }

        // Si tiene botones → PAUSAR el flujo y esperar respuesta del cliente
        if (buttons.length > 0) {
          // Guardar estado: en qué nodo quedó el flujo y las opciones disponibles
          const buttonOptions = buttons.map((b, i) => ({
            index: i,
            label: b.toLowerCase(),
            handle: `output-btn-${i}`
          }));

          await supabase.from('conversations').update({
            current_flow_id: flowId,
            current_node_id: currentNodeId,
            flow_active: true
          }).eq('id', conversationId);

          console.log(`[Baileys Flow] Flujo pausado en nodo ${currentNodeId} esperando respuesta de botón`);
          return; // Detener ejecución hasta que el cliente responda
        }
        break;
      }

      // ── Agente IA ─────────────────────────────────────────
      case 'ai':
      case 'ai_agent': {
        const { data: conv } = await supabase
          .from('conversations')
          .select('user_id, active_price')
          .eq('id', conversationId)
          .single();

        if (conv) {
          await respondWithAIBaileys(conv.user_id, sock, jid, userMessage, conversationId);
        }
        break;
      }

      // ── Delay ─────────────────────────────────────────────
      case 'delay': {
        const seconds = node.data?.seconds || 3;
        console.log(`[Baileys Flow] Delay de ${seconds} segundos`);
        await sleep(seconds * 1000);
        break;
      }

      // ── Seguimiento ───────────────────────────────────────
      case 'followup':
      case 'delay_followup': {
        const seguimientos = node.data?.seguimientos || [];
        const { data: conv } = await supabase
          .from('conversations')
          .select('user_id')
          .eq('id', conversationId)
          .single();

        for (const seg of seguimientos) {
          const minutos = seg.tiempo_minutos || 0;
          const precio = seg.precio || '';

          if (minutos > 0) {
            // Programar seguimiento diferido
            const sendAt = new Date(Date.now() + minutos * 60 * 1000).toISOString();
            await supabase.from('scheduled_followups').insert({
              id: uuidv4(),
              conversation_id: conversationId,
              connection_id: null, // QR no tiene connection_id de API
              contact_phone: contactPhone,
              followup_data: { ...seg, _baileys_connection_id: conv?.user_id },
              status: 'pending',
              send_at: sendAt,
              created_at: new Date().toISOString()
            });
            console.log(`[Baileys Flow] Seguimiento programado para ${minutos} min`);
          } else {
            // Enviar inmediatamente
            if (precio) {
              await supabase.from('conversations').update({ active_price: precio }).eq('id', conversationId);
            }
            for (const contenido of seg.contenidos || []) {
              await sendFollowupContent(sock, jid, contenido, conversationId);
            }
          }
        }
        break;
      }

      // ── Notificación ──────────────────────────────────────
      case 'notification':
      case 'notify': {
        const notifyPhone = node.data?.phone || '';
        const msg = (node.data?.message || '').replace('{{phone}}', contactPhone);
        if (notifyPhone && msg) {
          try {
            await sock.sendMessage(`${notifyPhone}@s.whatsapp.net`, { text: msg });
          } catch (e) {}
        }
        break;
      }

      case 'end':
        currentNodeId = null;
        continue;
    }

    // Avanzar al siguiente nodo (primer edge sin sourceHandle específico)
    const nextEdges = edgeMap[currentNodeId] || [];
    const defaultEdge = nextEdges.find(e => !e.handle || e.handle === 'default') || nextEdges[0];
    currentNodeId = defaultEdge?.target || null;
  }
}

// ── Continuar flujo desde respuesta de botón ─────────────────
async function continueFlowFromButtonBaileys(flowId, pausedNodeId, userResponse, sock, jid, contactPhone, conversationId) {
  const { data: flow } = await supabase.from('flows').select('*').eq('id', flowId).single();
  if (!flow) return false;

  const nodeMap = {};
  flow.nodes.forEach(n => { nodeMap[n.id] = n; });

  const pausedNode = nodeMap[pausedNodeId];
  if (!pausedNode) return false;

  const buttons = pausedNode.data?.buttons || [];
  if (!buttons.length) return false;

  // Determinar qué botón eligió el cliente
  const response = userResponse.toLowerCase().trim();
  let matchedHandle = null;

  // Buscar por número (1, 2, 3...)
  const numMatch = response.match(/^(\d+)/);
  if (numMatch) {
    const idx = parseInt(numMatch[1]) - 1;
    if (idx >= 0 && idx < buttons.length) {
      matchedHandle = `output-btn-${idx}`;
    }
  }

  // Buscar por texto del botón
  if (!matchedHandle) {
    for (let i = 0; i < buttons.length; i++) {
      if (response.includes(buttons[i].toLowerCase()) ||
          buttons[i].toLowerCase().includes(response)) {
        matchedHandle = `output-btn-${i}`;
        break;
      }
    }
  }

  // Si no coincide con ningún botón, usar el primero por defecto
  if (!matchedHandle) matchedHandle = 'output-btn-0';

  // Encontrar el edge correcto
  const matchedEdge = (flow.edges || []).find(e =>
    e.source === pausedNodeId && e.sourceHandle === matchedHandle
  );

  if (!matchedEdge) return false;

  // Limpiar estado pausado
  await supabase.from('conversations').update({
    current_node_id: null,
    current_flow_id: null
  }).eq('id', conversationId);

  // Continuar flujo desde el nodo siguiente
  console.log(`[Baileys Flow] Continuando desde botón ${matchedHandle} → ${matchedEdge.target}`);
  await executeFlowBaileys(flowId, sock, jid, contactPhone, userResponse, conversationId, matchedEdge.target);
  return true;
}

// ── Enviar contenido de seguimiento ─────────────────────────
async function sendFollowupContent(sock, jid, contenido, conversationId) {
  const tipo = (contenido.tipo || '').toLowerCase();
  if (tipo === 'texto') {
    await sendText(sock, jid, contenido.texto || '', conversationId);
  } else if (tipo === 'imagen') {
    await sendImage(sock, jid, contenido.url || '', contenido.caption || '', conversationId);
  } else if (tipo === 'pausa') {
    await sleep((contenido.segundos || 1) * 1000);
  }
  await sleep(500);
}

// ── Responder con IA ─────────────────────────────────────────
async function respondWithAIBaileys(userId, sock, jid, userMessage, conversationId) {
  try {
    const { data: convData } = await supabase
      .from('conversations')
      .select('ai_config_id, active_price')
      .eq('id', conversationId)
      .single();

    let aiConfig = null;
    if (convData?.ai_config_id) {
      const { data: c } = await supabase.from('ai_config').select('*').eq('id', convData.ai_config_id).single();
      aiConfig = c;
    }
    if (!aiConfig) {
      const { data: c } = await supabase.from('ai_config').select('*').eq('user_id', userId).eq('is_active', true).single();
      aiConfig = c;
    }
    if (!aiConfig) return;

    let systemPrompt = aiConfig.system_prompt || 'Eres un asistente de ventas amable. Responde en español.';
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
      { model: aiConfig.model || 'meta-llama/llama-4-scout-17b-16e-instruct', max_tokens: 500, messages },
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );

    const aiResponse = response.data.choices[0].message.content;
    await sendText(sock, jid, aiResponse, conversationId);
  } catch (err) {
    console.error('[Baileys AI error]', err.message);
  }
}

// ════════════════════════════════════════════════════════════
// PROCESAR MENSAJE ENTRANTE
// ════════════════════════════════════════════════════════════
async function processBaileysMessage(connectionId, userId, sock, contactPhone, userMessage, isImage, rawMsg, rawJid) {
  const jid = rawJid || `${contactPhone}@s.whatsapp.net`;

  // Buscar o crear conversación
  let { data: conversation } = await supabase
    .from('conversations')
    .select('*')
    .eq('user_id', userId)
    .eq('contact_phone', contactPhone)
    .eq('connection_id', connectionId)
    .single();

  if (!conversation) {
    const { data: newConv } = await supabase
      .from('conversations')
      .insert({
        id: uuidv4(),
        user_id: userId,
        connection_id: connectionId,
        contact_phone: contactPhone,
        contact_name: contactPhone,
        status: 'active',
        unread_count: 1,
        flow_active: true,
        last_message: isImage ? '[Imagen]' : userMessage.slice(0, 100),
        last_message_at: new Date().toISOString()
      })
      .select()
      .single();
    conversation = newConv;
  }

  if (!conversation) return;
  if (conversation.is_blocked) return;

  await saveMsg(conversation.id, isImage ? '[Imagen recibida]' : userMessage, 'inbound', isImage ? 'image' : 'text');

  if (conversation.flow_active === false) {
    // Bot apagado — solo IA si está configurada
    await respondWithAIBaileys(userId, sock, jid, userMessage, conversation.id);
    return;
  }

  // ── Si hay flujo pausado esperando botón, continuar ───────
  if (conversation.current_flow_id && conversation.current_node_id) {
    console.log(`[Baileys] Flujo pausado detectado, intentando continuar...`);
    const handled = await continueFlowFromButtonBaileys(
      conversation.current_flow_id,
      conversation.current_node_id,
      userMessage,
      sock,
      jid,
      contactPhone,
      conversation.id
    );
    if (handled) {
      console.log(`[Baileys] Flujo continuado desde respuesta: "${userMessage}"`);
      return;
    }
    // No coincidió con ningún botón → IA responde sin perder estado pausado
    console.log(`[Baileys] Respuesta no coincide con botones — IA responde manteniendo flujo pausado`);
    await respondWithAIBaileys(userId, sock, jid, userMessage, conversation.id);
    return;
  }

  const normalizedMsg = userMessage.toLowerCase().trim();

  // ── Buscar triggers ───────────────────────────────────────
  const { data: triggers } = await supabase
    .from('triggers')
    .select('*')
    .eq('user_id', userId)
    .eq('connection_id', connectionId)
    .eq('is_active', true);

  if (!triggers?.length) {
    await respondWithAIBaileys(userId, sock, jid, userMessage, conversation.id);
    return;
  }

  const matchedTrigger = triggers.find(t => {
    const kw = t.keyword.toLowerCase().trim();
    return normalizedMsg === kw || normalizedMsg.includes(kw);
  });

  if (!matchedTrigger) {
    const defaultTrigger = triggers.find(t => t.keyword === '*' || t.keyword === 'default');
    if (defaultTrigger) {
      await executeFlowBaileys(defaultTrigger.flow_id, sock, jid, contactPhone, userMessage, conversation.id);
    } else {
      await respondWithAIBaileys(userId, sock, jid, userMessage, conversation.id);
    }
    return;
  }

  // Verificar si el trigger es repetible
  if (!matchedTrigger.is_repeatable) {
    const { count } = await supabase
      .from('trigger_executions')
      .select('*', { count: 'exact', head: true })
      .eq('trigger_id', matchedTrigger.id)
      .eq('contact_phone', contactPhone);
    if (count > 0) {
      await respondWithAIBaileys(userId, sock, jid, userMessage, conversation.id);
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

  console.log(`[Baileys] Ejecutando flujo para trigger "${matchedTrigger.keyword}"`);
  await executeFlowBaileys(matchedTrigger.flow_id, sock, jid, contactPhone, userMessage, conversation.id);
}

// ════════════════════════════════════════════════════════════
// INICIAR SESIÓN QR
// ════════════════════════════════════════════════════════════
async function startQRSession(connectionId, userId) {
  try {
    console.log(`[Baileys] Iniciando sesión QR para: ${connectionId}`);

    if (activeSessions[connectionId]) {
      try { activeSessions[connectionId].end(); } catch (e) {}
      delete activeSessions[connectionId];
    }

    const sessionPath = getSessionPath(connectionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['AriaBot', 'Chrome', '1.0.0']
    });

    activeSessions[connectionId] = sock;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrBase64 = await QRCode.toDataURL(qr);
          await supabase.from('connections').update({ qr_code: qrBase64, qr_status: 'pending' }).eq('id', connectionId);
          console.log(`[Baileys] QR generado para ${connectionId}`);
        } catch (e) { console.error('[Baileys] Error guardando QR:', e.message); }
      }

      if (connection === 'open') {
        const phoneNumber = sock.user?.id?.split(':')[0] || '';
        console.log(`[Baileys] Conectado: ${phoneNumber}`);
        await supabase.from('connections').update({
          qr_status: 'connected',
          qr_code: null,
          phone_number: phoneNumber,
          is_active: true
        }).eq('id', connectionId);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`[Baileys] Desconectado (${connectionId}), código: ${statusCode}`);

        await supabase.from('connections').update({
          qr_status: shouldReconnect ? 'reconnecting' : 'disconnected',
          is_active: false
        }).eq('id', connectionId);

        delete activeSessions[connectionId];

        if (shouldReconnect) {
          console.log(`[Baileys] Reconectando en 5 segundos...`);
          setTimeout(() => startQRSession(connectionId, userId), 5000);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        const rawJid = msg.key.remoteJid || '';
        let contactPhone = rawJid.replace('@s.whatsapp.net', '').replace('@lid', '').replace('@g.us', '');

        if (rawJid.includes('@lid') && msg.key.participant) {
          contactPhone = msg.key.participant.replace('@s.whatsapp.net', '').replace('@lid', '');
        }

        if (!contactPhone) continue;

        const userMessage =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption || '';

        const isImage = !!msg.message.imageMessage;

        console.log(`[Baileys] Mensaje de ${contactPhone}: "${userMessage}"`);

        try {
          await processBaileysMessage(connectionId, userId, sock, contactPhone, userMessage, isImage, msg, rawJid);
        } catch (err) {
          console.error('[Baileys] Error procesando mensaje:', err.message);
        }
      }
    });

    return { success: true };
  } catch (err) {
    console.error('[Baileys] Error iniciando sesión:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Obtener QR ───────────────────────────────────────────────
async function getQRCode(connectionId) {
  const { data } = await supabase.from('connections').select('qr_code, qr_status, phone_number').eq('id', connectionId).single();
  return data;
}

// ── Cerrar sesión ────────────────────────────────────────────
async function closeQRSession(connectionId) {
  if (activeSessions[connectionId]) {
    try { await activeSessions[connectionId].logout(); } catch (e) {}
    delete activeSessions[connectionId];
  }
  await supabase.from('connections').update({ qr_status: 'disconnected', qr_code: null, is_active: false }).eq('id', connectionId);
}

// ── Restaurar sesiones al arrancar ───────────────────────────
async function restoreActiveSessions() {
  try {
    const { data: qrConnections } = await supabase
      .from('connections')
      .select('id, user_id')
      .eq('connection_type', 'qr')
      .eq('qr_status', 'connected');

    if (!qrConnections?.length) return;
    console.log(`[Baileys] Restaurando ${qrConnections.length} sesiones...`);
    for (const conn of qrConnections) {
      await startQRSession(conn.id, conn.user_id);
    }
  } catch (err) {
    console.error('[Baileys] Error restaurando sesiones:', err.message);
  }
}

module.exports = { startQRSession, getQRCode, closeQRSession, restoreActiveSessions };
