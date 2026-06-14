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
          if (msg.type !== 'text' && msg.type !== 'interactive' && msg.type !== 'image') continue;

          const contactPhone = msg.from;
          const isButton = msg.type === 'interactive';
          const isImage = msg.type === 'image';

          const userMessage = msg.type === 'text'
            ? msg.text?.body || ''
            : msg.type === 'interactive'
              ? msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || ''
              : '[imagen]';

          if (!userMessage) continue;

          console.log(`[Webhook] Mensaje de ${contactPhone}: "${userMessage}" (tipo: ${msg.type})`);

          processIncomingMessage(phoneNumberId, contactPhone, userMessage, isButton, isImage).catch(err => {
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
async function processIncomingMessage(phoneNumberId, contactPhone, userMessage, isButton = false, isImage = false) {
  // 1. Buscar conexión
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

  // 2. Obtener o crear conversación
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

  // 3. Guardar mensaje entrante
  await saveMessage(conversation.id, userMessage, 'inbound');

  const normalizedMsg = userMessage.toLowerCase().trim();

  // 4. Buscar triggers activos
  const { data: triggers } = await supabase
    .from('triggers')
    .select('*, flows(id, nodes, edges, is_active)')
    .eq('user_id', userId)
    .eq('connection_id', connection.id)
    .eq('is_active', true);

  // 5. Si el mensaje es un BOTÓN (Yape/Plin/Transferencia)
  // buscar en el flujo activo el nodo AI con ese camino
  if (isButton) {
    console.log(`[Webhook] Botón presionado: "${userMessage}"`);

    // Buscar el flujo que tiene ese botón como camino del Agente IA
    for (const trigger of (triggers || [])) {
      const flow = trigger.flows;
      if (!flow?.nodes) continue;

      const aiNode = flow.nodes.find(n =>
        (n.type === 'ai' || n.type === 'ai_agent') &&
        n.data?.paths?.some(p => p.label?.toLowerCase() === normalizedMsg)
      );

      if (aiNode) {
        console.log(`[Webhook] Avanzando por camino "${userMessage}" en flujo ${flow.id}`);
        await executeFlowFromNode(flow, aiNode.id, normalizedMsg, contactPhone, userMessage, connection, conversation.id);
        return;
      }
    }

    // Si no encontró camino específico, responder con IA
    await respondWithAI(userId, contactPhone, userMessage, connection, conversation.id);
    return;
  }

  // 6. Buscar trigger que coincida con texto
  const matchedTrigger = (triggers || []).find(t => {
    const kw = (t.keyword || '').toLowerCase().trim();
    return normalizedMsg === kw || normalizedMsg.includes(kw);
  });

  if (matchedTrigger) {
    // Verificar si es repetible
    if (!matchedTrigger.is_repeatable) {
      const { count } = await supabase
        .from('trigger_executions')
        .select('*', { count: 'exact', head: true })
        .eq('trigger_id', matchedTrigger.id)
        .eq('contact_phone', contactPhone);

      if (count > 0) {
        console.log(`[Webhook] Trigger no repetible ya ejecutado para ${contactPhone}`);
        // Si ya ejecutó el flujo antes, responder con IA
        await respondWithAI(userId, contactPhone, userMessage, connection, conversation.id);
        return;
      }
    }

    // Registrar ejecución
    await supabase.from('trigger_executions').insert({
      id: uuidv4(),
      trigger_id: matchedTrigger.id,
      contact_phone: contactPhone,
      conversation_id: conversation.id,
      executed_at: new Date().toISOString()
    });

    console.log(`[Webhook] Ejecutando flujo "${matchedTrigger.flow_id}" para trigger "${matchedTrigger.keyword}"`);
    await executeFlow(matchedTrigger.flow_id, contactPhone, userMessage, connection, conversation.id);
    return;
  }

  // 7. Sin coincidencia → responder con IA
  console.log(`[Webhook] Sin trigger para "${normalizedMsg}" → usando IA`);
  await respondWithAI(userId, contactPhone, userMessage, connection, conversation.id);
}

// ── Ejecutar flujo desde un nodo específico ──────────────────
async function executeFlowFromNode(flow, fromNodeId, buttonLabel, contactPhone, userMessage, connection, conversationId) {
  const { executeFlow } = require('../services/flowEngine');

  // Encontrar el edge que sale del nodo AI con ese label
  const edges = flow.edges || [];
  const matchingEdge = edges.find(e =>
    e.source === fromNodeId &&
    (e.label?.toLowerCase() === buttonLabel || e.sourceHandle?.toLowerCase() === buttonLabel)
  );

  if (!matchingEdge) {
    console.log(`[Webhook] No se encontró edge para camino "${buttonLabel}"`);
    await respondWithAI(connection.user_id, contactPhone, userMessage, connection, conversationId);
    return;
  }

  // Crear un flujo temporal que empieza desde el nodo siguiente
  const targetNodeId = matchingEdge.target;
  const nodeMap = {};
  flow.nodes.forEach(n => { nodeMap[n.id] = n; });

  const edgeMap = {};
  edges.forEach(e => {
    if (!edgeMap[e.source]) edgeMap[e.source] = [];
    edgeMap[e.source].push(e.target);
  });

  // Ejecutar nodos desde el target
  const { sendWhatsAppMessage, saveMessage } = require('../services/flowEngine');
  let currentNodeId = targetNodeId;

  while (currentNodeId) {
    const node = nodeMap[currentNodeId];
    if (!node) break;

    console.log(`[Flow] Ejecutando nodo: ${node.type} (${node.id})`);

    if (node.type === 'content') {
      const items = node.data?.items || [];
      for (const item of items) {
        if (item.type === 'text') {
          await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, item.text || '');
          await saveMessage(conversationId, item.text || '', 'outbound');
        } else if (item.type === 'image') {
          const { default: axios } = await import('axios').catch(() => ({ default: require('axios') }));
          try {
            await require('axios').post(
              `https://graph.facebook.com/v19.0/${connection.phone_number_id}/messages`,
              {
                messaging_product: 'whatsapp',
                to: contactPhone,
                type: 'image',
                image: { link: item.url, ...(item.caption ? { caption: item.caption } : {}) }
              },
              { headers: { Authorization: `Bearer ${connection.access_token}`, 'Content-Type': 'application/json' } }
            );
            await saveMessage(conversationId, item.caption || '[Imagen]', 'outbound');
          } catch (e) {
            console.error('[Image error]', e.response?.data || e.message);
          }
        } else if (item.type === 'interval') {
          await new Promise(r => setTimeout(r, (item.seconds || 3) * 1000));
        }
        await new Promise(r => setTimeout(r, 500));
      }
    } else if (node.type === 'notification' || node.type === 'notify') {
      const notifyPhone = node.data?.phone || '';
      const msg = (node.data?.message || '').replace('{{userNumber}}', contactPhone);
      if (notifyPhone) {
        await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, notifyPhone, msg);
      }
    } else if (node.type === 'end') {
      break;
    }

    currentNodeId = edgeMap[currentNodeId]?.[0] || null;
  }
}

// ── Responder con IA usando config del usuario ────────────────
async function respondWithAI(userId, contactPhone, userMessage, connection, conversationId) {
  try {
    // Obtener config de IA del usuario
    const { data: aiConfig } = await supabase
      .from('ai_config')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (!aiConfig?.is_active) {
      console.log(`[AI Fallback] IA desactivada o sin configurar para user ${userId}`);
      return;
    }

    // Obtener historial de conversación
    const { data: history } = await supabase
      .from('messages')
      .select('content, direction')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(15);

    const systemPrompt = aiConfig.system_prompt ||
      'Eres un asistente de ventas amable. Responde en español de forma concisa.';

    const messages = [
      { role: 'system', content: systemPrompt },
      ...(history || []).slice(-10).map(m => ({
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        content: m.content
      })),
      { role: 'user', content: userMessage }
    ];

    const groqResponse = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: aiConfig.model || 'meta-llama/llama-4-scout-17b-16e-instruct',
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

    const aiResponse = groqResponse.data.choices[0].message.content;
    console.log(`[AI Fallback] Respondiendo a ${contactPhone}`);

    await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, aiResponse);
    await saveMessage(conversationId, aiResponse, 'outbound');

  } catch (err) {
    console.error('[AI Fallback error]', err.response?.data || err.message);
  }
}

module.exports = router;
