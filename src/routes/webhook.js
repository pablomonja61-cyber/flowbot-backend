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
          if (msg.type !== 'text' && msg.type !== 'interactive') continue;

          const contactPhone = msg.from;
          const userMessage = msg.type === 'text'
            ? msg.text?.body || ''
            : msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';

          if (!userMessage) continue;

          console.log(`[Webhook] Mensaje de ${contactPhone}: "${userMessage}"`);

          processIncomingMessage(phoneNumberId, contactPhone, userMessage).catch(err => {
            console.error('[Webhook] Error procesando mensaje:', err.message);
          });
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Error parseando body:', err.message);
  }
});

// ── Responder con IA usando config de Supabase ───────────────
async function respondWithAI(userId, connection, contactPhone, userMessage, conversationId) {
  try {
    // Obtener config de IA del usuario
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

    // Obtener historial reciente
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

    console.log('[AI Fallback] Llamando a Groq con modelo:', model);

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

    await sendWhatsAppMessage(
      connection.phone_number_id,
      connection.access_token,
      contactPhone,
      aiResponse
    );
    await saveMessage(conversationId, aiResponse, 'outbound');

  } catch (err) {
    console.error('[AI Fallback error]', err.response?.data || err.message);
  }
}

// ════════════════════════════════════════════════════════════
// Lógica principal
// ════════════════════════════════════════════════════════════
async function processIncomingMessage(phoneNumberId, contactPhone, userMessage) {
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

  // 4. Buscar triggers activos
  const normalizedMsg = userMessage.toLowerCase().trim();

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

  // 5. Buscar trigger que coincida
  const matchedTrigger = triggers.find(t => {
    const kw = t.keyword.toLowerCase().trim();
    return normalizedMsg === kw || normalizedMsg.includes(kw);
  });

  if (!matchedTrigger) {
    // Buscar trigger default (*)
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
      // Sin coincidencia → IA responde automáticamente
      console.log(`[Webhook] Sin coincidencia para "${normalizedMsg}" — usando IA fallback`);
      await respondWithAI(userId, connection, contactPhone, userMessage, conversation.id);
    }
    return;
  }

  // 6. Verificar si es repetible
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

  // 7. Registrar ejecución
  await supabase.from('trigger_executions').insert({
    id: uuidv4(),
    trigger_id: matchedTrigger.id,
    contact_phone: contactPhone,
    conversation_id: conversation.id,
    executed_at: new Date().toISOString()
  });

  // 8. Ejecutar flujo
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
