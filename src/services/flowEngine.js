const axios = require('axios');
const supabase = require('../models/supabase');

// ── Llamar a Groq con contexto del producto ──────────────────
async function callGroqAI(systemPrompt, conversationHistory, userMessage) {
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
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
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

// ── Enviar mensaje por WhatsApp ──────────────────────────────
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
  } catch (err) {
    console.error('[WhatsApp send error]', err.response?.data || err.message);
  }
}

// ── Enviar botones interactivos ──────────────────────────────
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

// ── Espera (delay) ───────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ════════════════════════════════════════════════════════════
// MOTOR DE FLUJOS — ejecuta nodo por nodo
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
        const text = node.data?.text || node.data?.content || '';
        if (text) {
          await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, text);
          await saveMessage(conversationId, text, 'outbound');
        }
        if (node.data?.delay_seconds) await sleep(node.data.delay_seconds * 1000);
        break;
      }

      case 'buttons':
      case 'api_message': {
        const text = node.data?.body || node.data?.text || '';
        const buttons = node.data?.buttons || [];
        if (buttons.length > 0) {
          await sendWhatsAppButtons(connection.phone_number_id, connection.access_token, contactPhone, text, buttons);
        } else if (text) {
          await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, text);
        }
        await saveMessage(conversationId, text, 'outbound');
        break;
      }

      case 'ai':
      case 'ai_agent': {
        const systemPrompt = node.data?.context ||
          'Eres un asistente de ventas amable y profesional. Responde en español.';
        const aiResponse = await callGroqAI(systemPrompt, history || [], userMessage);
        lastAiResponse = aiResponse;
        await sendWhatsAppMessage(connection.phone_number_id, connection.access_token, contactPhone, aiResponse);
        await saveMessage(conversationId, aiResponse, 'outbound');
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
        const nextEdge = conditionMet ? yesEdge : noEdge;
        currentNodeId = nextEdge?.target || null;
        continue;
      }

      case 'delay': {
        const seconds = node.data?.seconds || 3;
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

      case 'notification': {
        const notifyPhone = node.data?.phone || '';
        const msg = (node.data?.message || 'Nueva conversación: {{phone}}')
          .replace('{{phone}}', contactPhone);
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

// ── Guardar mensaje en DB ────────────────────────────────────
async function saveMessage(conversationId, content, direction) {
  if (!conversationId || !content) return;
  await supabase.from('messages').insert({
    conversation_id: conversationId,
    content,
    direction,
    created_at: new Date().toISOString()
  });
  await supabase.from('conversations').update({
    last_message: content.slice(0, 100),
    last_message_at: new Date().toISOString(),
    ...(direction === 'inbound' ? { unread_count: 1 } : {})
  }).eq('id', conversationId);
}

module.exports = { executeFlow, saveMessage, sendWhatsAppMessage };