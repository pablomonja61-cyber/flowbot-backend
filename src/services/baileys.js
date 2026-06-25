const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const QRCode = require('qrcode');
const supabase = require('../models/supabase');
const { executeFlow, saveMessage, cancelFollowups } = require('./flowEngine');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// Mapa de sesiones activas en memoria: connectionId -> socket
const activeSessions = {};

// ── Obtener o crear carpeta de sesión para un connectionId ────
function getSessionPath(connectionId) {
  const dir = path.join('/tmp', 'baileys_sessions', connectionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ════════════════════════════════════════════════════════════
// Iniciar sesión de WhatsApp QR para una conexión
// ════════════════════════════════════════════════════════════
async function startQRSession(connectionId, userId) {
  try {
    console.log(`[Baileys] Iniciando sesión QR para conexión: ${connectionId}`);

    // Si ya hay una sesión activa, cerrarla primero
    if (activeSessions[connectionId]) {
      try {
        activeSessions[connectionId].end();
      } catch (e) {}
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

    // ── Eventos de conexión ───────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR generado — guardarlo en Supabase como base64
      if (qr) {
        try {
          const qrBase64 = await QRCode.toDataURL(qr);
          await supabase
            .from('connections')
            .update({
              qr_code: qrBase64,
              qr_status: 'pending'
            })
            .eq('id', connectionId);
          console.log(`[Baileys] QR generado para ${connectionId}`);
        } catch (e) {
          console.error('[Baileys] Error guardando QR:', e.message);
        }
      }

      // Conexión exitosa
      if (connection === 'open') {
        const phoneNumber = sock.user?.id?.split(':')[0] || '';
        console.log(`[Baileys] Conectado: ${phoneNumber} (${connectionId})`);

        await supabase
          .from('connections')
          .update({
            qr_status: 'connected',
            qr_code: null,
            phone_number: phoneNumber,
            is_active: true
          })
          .eq('id', connectionId);
      }

      // Desconexión
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[Baileys] Desconectado (${connectionId}), código: ${statusCode}, reconectar: ${shouldReconnect}`);

        await supabase
          .from('connections')
          .update({
            qr_status: shouldReconnect ? 'reconnecting' : 'disconnected',
            is_active: false
          })
          .eq('id', connectionId);

        delete activeSessions[connectionId];

        // Reconectar automáticamente si no fue logout manual
        if (shouldReconnect) {
          console.log(`[Baileys] Reconectando ${connectionId} en 5 segundos...`);
          setTimeout(() => startQRSession(connectionId, userId), 5000);
        }
      }
    });

    // ── Guardar credenciales cuando cambian ──────────────
    sock.ev.on('creds.update', saveCreds);

    // ── Mensajes entrantes ────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue; // ignorar mensajes propios
        if (!msg.message) continue;

        const rawJid = msg.key.remoteJid || '';
        // Manejar tanto formato @s.whatsapp.net como @lid
        let contactPhone = rawJid
          .replace('@s.whatsapp.net', '')
          .replace('@lid', '')
          .replace('@g.us', '');
        
        // Si es formato @lid (número largo), intentar obtener el teléfono real
        if (rawJid.includes('@lid')) {
          // Buscar en los participantes del mensaje si existe
          const participant = msg.key.participant || '';
          if (participant) {
            contactPhone = participant.replace('@s.whatsapp.net', '').replace('@lid', '');
          }
        }
        
        if (!contactPhone) continue;

        // Extraer texto del mensaje
        const userMessage =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          '';

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

// ════════════════════════════════════════════════════════════
// Procesar mensaje entrante de Baileys
// ════════════════════════════════════════════════════════════
async function processBaileysMessage(connectionId, userId, sock, contactPhone, userMessage, isImage, rawMsg, rawJid) {
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
        last_message: isImage ? '[Imagen]' : userMessage.slice(0, 100),
        last_message_at: new Date().toISOString()
      })
      .select()
      .single();
    conversation = newConv;
  }

  if (!conversation) return;
  if (conversation.is_blocked) return;

  await saveMessage(
    conversation.id,
    isImage ? '[Imagen recibida]' : userMessage,
    'inbound',
    isImage ? 'image' : 'text'
  );

  if (conversation.flow_active === false) return;

  // Usar el JID original para responder correctamente
  const jid = rawJid || `${contactPhone}@s.whatsapp.net`;

  const connection = {
    id: connectionId,
    user_id: userId,
    connection_type: 'qr',
    // Adaptar para que flowEngine pueda enviar por Baileys
    _baileysSock: sock,
    _baileysJid: jid
  };

  const normalizedMsg = userMessage.toLowerCase().trim();

  // Buscar triggers
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
      await executeFlowBaileys(defaultTrigger.flow_id, contactPhone, userMessage, sock, jid, userId, conversation.id);
    } else {
      await respondWithAIBaileys(userId, sock, jid, userMessage, conversation.id);
    }
    return;
  }

  // Registrar ejecución del trigger
  await supabase.from('trigger_executions').insert({
    id: uuidv4(),
    trigger_id: matchedTrigger.id,
    contact_phone: contactPhone,
    conversation_id: conversation.id,
    executed_at: new Date().toISOString()
  });

  await executeFlowBaileys(matchedTrigger.flow_id, contactPhone, userMessage, sock, jid, userId, conversation.id);
}

// ════════════════════════════════════════════════════════════
// Ejecutar flujo enviando mensajes por Baileys
// ════════════════════════════════════════════════════════════
async function executeFlowBaileys(flowId, contactPhone, userMessage, sock, jid, userId, conversationId) {
  const { data: flow } = await supabase
    .from('flows')
    .select('*')
    .eq('id', flowId)
    .single();

  if (!flow || !flow.nodes?.length) return;

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

  while (currentNodeId) {
    const node = nodeMap[currentNodeId];
    if (!node) break;

    console.log(`[Baileys Flow] Nodo: ${node.type} (${currentNodeId})`);
switch (node.type) {
      case 'message':
      case 'content': {
        const items = node.data?.items || [];
        for (const item of items) {
          const tipo = (item.type || '').toLowerCase();
          if (tipo === 'text' || tipo === 'texto') {
            const text = item.text || item.content || '';
            if (text) {
              try {
  await sock.sendMessage(jid, { text });
  console.log(`[Baileys] Mensaje enviado a ${jid}: ${text.slice(0, 50)}`);
} catch (sendErr) {
  console.error(`[Baileys] Error enviando mensaje a ${jid}:`, sendErr.message);
}
              await saveMessage(conversationId, text, 'outbound', 'text');
            }
          } else if (tipo === 'image' || tipo === 'imagen') {
            if (item.url) {
              await sock.sendMessage(jid, {
                image: { url: item.url },
                caption: item.caption || ''
              });
              await saveMessage(conversationId, item.caption || '[Imagen]', 'outbound', 'image', item.url);
            }
          } else if (tipo === 'interval') {
            await new Promise(r => setTimeout(r, Math.min((item.seconds || 1) * 1000, 30000)));
          }
          await new Promise(r => setTimeout(r, 500));
        }
        break;
      }

      case 'api':
      case 'buttons':
      case 'api_message': {
        // Baileys no soporta botones interactivos de WhatsApp Business API
        // Enviamos el texto con las opciones numeradas
        const text = node.data?.body || node.data?.text || '';
        const buttons = node.data?.buttons || [];
        let fullText = text;
        if (buttons.length > 0) {
          fullText += '\n\n' + buttons.map((b, i) => `${i + 1}. ${b}`).join('\n');
        }
        if (fullText) {
          await sock.sendMessage(jid, { text: fullText });
          await saveMessage(conversationId, fullText, 'outbound', 'text');
        }
        break;
      }

      case 'ai':
      case 'ai_agent': {
        await respondWithAIBaileys(userId, sock, jid, userMessage, conversationId);
        break;
      }

      case 'delay': {
        const seconds = node.data?.seconds || 3;
        await new Promise(r => setTimeout(r, Math.min(seconds * 1000, 30000)));
        break;
      }

      case 'notification':
      case 'notify': {
        const notifyPhone = node.data?.phone || '';
        const msg = (node.data?.message || '').replace('{{phone}}', jid.split('@')[0]);
        if (notifyPhone && msg) {
          await sock.sendMessage(`${notifyPhone}@s.whatsapp.net`, { text: msg });
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

// ════════════════════════════════════════════════════════════
// Responder con IA por Baileys
// ════════════════════════════════════════════════════════════
async function respondWithAIBaileys(userId, sock, jid, userMessage, conversationId) {
  try {
    const { data: convData } = await supabase
      .from('conversations')
      .select('active_price')
      .eq('id', conversationId)
      .single();

    const { data: aiConfig } = await supabase
      .from('ai_config')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (!aiConfig) return;

    const axios = require('axios');
    let systemPrompt = aiConfig.system_prompt || 'Eres un asistente de ventas amable. Responde en español.';

    if (convData?.active_price) {
      systemPrompt += `\n\n⚠️ PRECIO ACTUALIZADO: El precio actual es S/${convData.active_price}.`;
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
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    const aiResponse = response.data.choices[0].message.content;
    await sock.sendMessage(jid, { text: aiResponse });
    await saveMessage(conversationId, aiResponse, 'outbound', 'text');
  } catch (err) {
    console.error('[Baileys AI error]', err.message);
  }
}

// ── Obtener QR actual de una conexión ────────────────────────
async function getQRCode(connectionId) {
  const { data } = await supabase
    .from('connections')
    .select('qr_code, qr_status, phone_number')
    .eq('id', connectionId)
    .single();
  return data;
}

// ── Cerrar sesión QR ─────────────────────────────────────────
async function closeQRSession(connectionId) {
  if (activeSessions[connectionId]) {
    try {
      await activeSessions[connectionId].logout();
    } catch (e) {}
    delete activeSessions[connectionId];
  }
  await supabase
    .from('connections')
    .update({ qr_status: 'disconnected', qr_code: null, is_active: false })
    .eq('id', connectionId);
}

// ── Restaurar sesiones activas al arrancar el servidor ───────
async function restoreActiveSessions() {
  try {
    const { data: qrConnections } = await supabase
      .from('connections')
      .select('id, user_id')
      .eq('connection_type', 'qr')
      .eq('qr_status', 'connected');

    if (!qrConnections?.length) return;

    console.log(`[Baileys] Restaurando ${qrConnections.length} sesiones activas...`);
    for (const conn of qrConnections) {
      await startQRSession(conn.id, conn.user_id);
    }
  } catch (err) {
    console.error('[Baileys] Error restaurando sesiones:', err.message);
  }
}

module.exports = { startQRSession, getQRCode, closeQRSession, restoreActiveSessions };