const express = require('express');
const router = express.Router();
const supabase = require('../models/supabase');
const {
  executeFlow, saveMessage, isCountryBlocked,
  checkOtherFlowTrigger, continueFlowFromButton, processIncomingImageCloud, respondWithAI, cancelFollowups
} = require('../services/flowEngine');
const { v4: uuidv4 } = require('uuid');

// ════════════════════════════════════════════════════════════
// COLA DE PROCESAMIENTO POR CONTACTO
// Cada mensaje entrante de Meta llega como una petición HTTP
// separada, sin ningún orden garantizado entre sí — sin esta cola,
// dos mensajes casi simultáneos del mismo cliente podrían procesarse
// en paralelo y mezclar sus respuestas. Se declara UNA sola vez a
// nivel de módulo (no dentro del handler, o se reiniciaría vacía en
// cada petición y no serviría de nada).
// ════════════════════════════════════════════════════════════
const contactProcessingQueues = {};

function enqueueForContact(queueKey, taskFn) {
  const previous = contactProcessingQueues[queueKey] || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => taskFn());
  contactProcessingQueues[queueKey] = next;
  return next;
}

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
  // Responder 200 inmediatamente a Meta (requiere <5s)
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
          const queueKey = `${phoneNumberId}:${contactPhone}`;

          if (msg.type === 'image') {
            enqueueForContact(queueKey, () => processIncomingImageMessage(phoneNumberId, contactPhone, msg)).catch(err => {
              console.error('[Webhook] Error procesando imagen:', err.message);
            });
            continue;
          }

          if (msg.type !== 'text' && msg.type !== 'interactive') continue;

          const userMessage = msg.type === 'text'
            ? msg.text?.body || ''
            : msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';

          if (!userMessage || !userMessage.trim()) continue;

          console.log(`[Webhook] Mensaje de ${contactPhone}: "${userMessage}"`);

          enqueueForContact(queueKey, () => processIncomingMessage(phoneNumberId, contactPhone, userMessage)).catch(err => {
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
// Procesar imagen entrante (posible comprobante de pago)
// ════════════════════════════════════════════════════════════
async function processIncomingImageMessage(phoneNumberId, contactPhone, msg) {
  const { data: connection } = await supabase
    .from('connections')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .eq('is_active', true)
    .single();

  if (!connection) return;
  const userId = connection.user_id;

  if (await isCountryBlocked(userId, contactPhone)) {
    console.log(`[Webhook] 🚫 País bloqueado — ignorando imagen de ${contactPhone}`);
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
        id: uuidv4(), user_id: userId, connection_id: connection.id,
        contact_phone: contactPhone, contact_name: contactPhone,
        status: 'active', unread_count: 1,
        last_message: '[Imagen]', last_message_at: new Date().toISOString()
      })
      .select().single();
    conversation = newConv;
  }

  const mediaId = msg.image?.id;
  if (!mediaId) return;

  await processIncomingImageCloud(connection, contactPhone, mediaId, conversation.id);
}

// ════════════════════════════════════════════════════════════
// Lógica principal: recibe msg → busca trigger → ejecuta flujo
// ════════════════════════════════════════════════════════════
async function processIncomingMessage(phoneNumberId, contactPhone, userMessage) {
  // 1. Buscar la conexión por phone_number_id
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

  // 1.5 Bloqueo por país — ni se guarda ni activa flujos
  if (await isCountryBlocked(userId, contactPhone)) {
    console.log(`[Webhook] 🚫 País bloqueado — ignorando mensaje de ${contactPhone}`);
    return;
  }

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

  // 3.5 ¿Hay un flujo pausado esperando respuesta en esta conversación?
  if (conversation.current_flow_id && conversation.current_node_id) {
    console.log(`[Webhook] Flujo pausado detectado en nodo: ${conversation.current_node_id}`);

    const { data: pausedFlowData } = await supabase
      .from('flows')
      .select('nodes')
      .eq('id', conversation.current_flow_id)
      .single();
    const pausedNode = (pausedFlowData?.nodes || []).find(n => n.id === conversation.current_node_id);

    if (pausedNode?.data?.triggerOtherFlows === true) {
      const otherTrigger = await checkOtherFlowTrigger(userId, connection.id, contactPhone, userMessage);
      if (otherTrigger) {
        console.log(`[Webhook] "Activar otros flujos" activo — trigger "${otherTrigger.keyword}" coincide`);
        await supabase.from('conversations').update({ current_flow_id: null, current_node_id: null }).eq('id', conversation.id);
        try { await cancelFollowups(conversation.id); } catch (e) { console.error('[Webhook] Error cancelando seguimientos:', e.message); }

        const { data: newFlow } = await supabase.from('flows').select('nodes').eq('id', otherTrigger.flow_id).single();
        const startNode = (newFlow?.nodes || []).find(n => n.type === 'start');
        if (startNode) {
          await supabase.from('trigger_executions').insert({ trigger_id: otherTrigger.id, contact_phone: contactPhone });
          await executeFlow(otherTrigger.flow_id, contactPhone, userMessage, connection, conversation.id, startNode.id);
          return;
        }
      }
    }

    const handled = await continueFlowFromButton(
      conversation.current_flow_id,
      conversation.current_node_id,
      userMessage,
      connection, contactPhone,
      conversation.id
    );
    if (handled) return;

    console.log(`[Webhook] IA responde duda mientras flujo sigue pausado`);
    await respondWithAI(userId, connection, contactPhone, userMessage, conversation.id);
    return;
  }

  // 4. Buscar trigger que coincida con el mensaje
  const normalizedMsg = userMessage.toLowerCase().trim();

  const { data: triggers } = await supabase
    .from('triggers')
    .select('*, flows(id, nodes, edges, is_active)')
    .eq('user_id', userId)
    .eq('connection_id', connection.id)
    .eq('is_active', true);

  if (!triggers?.length) {
    console.log(`[Webhook] No hay triggers activos para user ${userId}`);
    return;
  }

  // Buscar trigger que coincida (exact match o contains)
  const matchedTrigger = triggers.find(t => {
    const kw = t.keyword.toLowerCase().trim();
    return normalizedMsg === kw || normalizedMsg.includes(kw);
  });

  if (!matchedTrigger) {
    // Buscar si hay algún flujo con Agente IA como respuesta por defecto
    const defaultTrigger = triggers.find(t => t.keyword === '*' || t.keyword === 'default');
    if (!defaultTrigger) {
      console.log(`[Webhook] Sin coincidencia para: "${normalizedMsg}"`);
      return;
    }
    // Ejecutar flujo default
    await executeFlow(
      defaultTrigger.flow_id,
      contactPhone,
      userMessage,
      connection,
      conversation.id
    );
    return;
  }

  // 5. Verificar si es repetible o ya fue ejecutado
  if (!matchedTrigger.is_repeatable) {
    const { count } = await supabase
      .from('trigger_executions')
      .select('*', { count: 'exact', head: true })
      .eq('trigger_id', matchedTrigger.id)
      .eq('contact_phone', contactPhone);
    if (count > 0) {
      console.log(`[Webhook] Trigger no repetible ya ejecutado para ${contactPhone}`);
      return;
    }
  }

  // 6. Registrar ejecución del trigger
  await supabase.from('trigger_executions').insert({
    id: uuidv4(),
    trigger_id: matchedTrigger.id,
    contact_phone: contactPhone,
    conversation_id: conversation.id,
    executed_at: new Date().toISOString()
  });

  // 7. Ejecutar el flujo
  console.log(`[Webhook] Ejecutando flujo "${matchedTrigger.flows?.id}" para trigger "${matchedTrigger.name}"`);
  await executeFlow(
    matchedTrigger.flow_id,
    contactPhone,
    userMessage,
    connection,
    conversation.id
  );
}

module.exports = router;
