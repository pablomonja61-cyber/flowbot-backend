const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const supabase = require('../models/supabase');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
    // Fallback: enviar como texto
    const text = bodyText + '\n\n' + buttons.map((b, i) => `${i + 1}. ${b}`).join('\n');
    await sendWhatsAppMessage(phoneNumberId, accessToken, to, text);
  }
}

// ── Llamar a Claude con contexto del producto ────────────────
async function callClaudeAI(systemPrompt, conversationHistory, userMessage) {
  try {
    const messages = [
      ...conversationHistory.slice(-10).map(m => ({
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        content: m.content
      })),
      { role: 'user', content: userMessage }
    ];

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: systemPrompt,
      messages
    });

    return response.content[0].text;
  } catch (err) {
    console.error('[Claude error]', err.message);
    return 'Lo siento, en este momento no puedo responder. Por favor intenta en unos minutos.';
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
  // 1. Cargar flujo
  const { data: flow } = await supabase
    .from('flows')
    .select('*')
    .eq('id', flowId)
    .single();

  if (!flow || !flow.nodes?.length) return;

  // 2. Cargar historial de conversación para IA
  const { data: history } = await supabase
    .from('messages')
    .select('content, direction')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(20);

  // 3. Construir mapa de nodos y edges
  const nodeMap = {};
  flow.nodes.forEach(n => { nodeMap[n.id] = n; });

  const edgeMap = {}; // sourceId -> [targetId, ...]
  (flow.edges || []).forEach(e => {
    if (!edgeMap[e.source]) edgeMap[e.source] = [];
    edgeMap[e.source].push(e.target);
  });

  // 4. Encontrar nodo de inicio
  const startNode = flow.nodes.find(n => n.type === 'start' || n.type === 'trigger');
  if (!startNode) return;

  // 5. Ejecutar nodos en cadena
  let currentNodeId = edgeMap[startNode.id]?.[0];
  let lastAiResponse = null;

  while (currentNodeId) {
    const node = nodeMap[currentNodeId];
    if (!node) break;

    console.log(`[Flow] Ejecutando nodo: ${node.type} (${node.id})`);

    switch (node.type) {

      // ── Mensaje de texto / contenido ──────────────────────
      case 'message':
      case 'content': {
        const text = node.data?.text || node.data?.content || '';
        if (text) {
          await sendWhatsAppMessage(
            connection.phone_number_id,
            connection.access_token,
            contactPhone,
            text
          );
          await saveMessage(conversationId, text, 'outbound');
        }
        if (node.data?.delay_seconds) {
          await sleep(node.data.delay_seconds * 1000);
        }
        break;
      }

      // ── Botones / Mensajes API ─────────────────────────────
      case 'buttons':
      case 'api_message': {
        const text = node.data?.body || node.data?.text || '';
        const buttons = node.data?.buttons || [];
        if (buttons.length > 0) {
          await sendWhatsAppButtons(
            connection.phone_number_id,
            connection.access_token,
            contactPhone,
            text,
            buttons
          );
        } else if (text) {
          await sendWhatsAppMessage(
            connection.phone_number_id,
            connection.access_token,
            contactPhone,
            text
          );
        }
        await saveMessage(conversationId, text, 'outbound');
        break;
      }

      // ── Agente IA ─────────────────────────────────────────
      case 'ai':
      case 'ai_agent': {
        const systemPrompt = node.data?.context ||
          'Eres un asistente de ventas amable y profesional. Responde en español.';
        const aiResponse = await callClaudeAI(
          systemPrompt,
          history || [],
          userMessage
        );
        lastAiResponse = aiResponse;
        await sendWhatsAppMessage(
          connection.phone_number_id,
          connection.access_token,
          contactPhone,
          aiResponse
        );
        await saveMessage(conversationId, aiResponse, 'outbound');
        break;
      }

      // ── Condición / bifurcación ────────────────────────────
      case 'condition': {
        const variable = node.data?.variable || 'message';
        const operator = node.data?.operator || 'contains';
        const value = (node.data?.value || '').toLowerCase();
        const checkText = (variable === 'ai_response' ? lastAiResponse : userMessage || '')
          .toLowerCase();

        let conditionMet = false;
        if (operator === 'contains') conditionMet = checkText.includes(value);
        else if (operator === 'equals') conditionMet = checkText === value;
        else if (operator === 'starts_with') conditionMet = checkText.startsWith(value);
        else if (operator === 'not_contains') conditionMet = !checkText.includes(value);

        // El edge con handle 'yes' va si se cumple, 'no' si no
        const edges = (flow.edges || []).filter(e => e.source === currentNodeId);
        const yesEdge = edges.find(e => e.sourceHandle === 'yes' || e.label === 'sí');
        const noEdge = edges.find(e => e.sourceHandle === 'no' || e.label === 'no');
        const nextEdge = conditionMet ? yesEdge : noEdge;
        currentNodeId = nextEdge?.target || null;
        continue; // saltar el avance automático
      }

      // ── Delay / espera ────────────────────────────────────
      case 'delay': {
        const seconds = node.data?.seconds || 3;
        await sleep(Math.min(seconds * 1000, 30000)); // max 30s
        break;
      }

      // ── Etiqueta (tag al contacto) ────────────────────────
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

      // ── Notificación (aviso interno) ──────────────────────
      case 'notification': {
        const notifyPhone = node.data?.phone || '';
        const msg = (node.data?.message || 'Nueva conversación: {{phone}}')
          .replace('{{phone}}', contactPhone);
        if (notifyPhone) {
          await sendWhatsAppMessage(
            connection.phone_number_id,
            connection.access_token,
            notifyPhone,
            msg
          );
        }
        break;
      }

      // ── Fin del flujo ─────────────────────────────────────
      case 'end':
        currentNodeId = null;
        continue;
    }

    // Avanzar al siguiente nodo (primer edge del nodo actual)
    currentNodeId = edgeMap[currentNodeId]?.[0] || null;
  }
}

// ── Cancelar seguimientos pendientes (ej. después de una venta) ──
async function cancelFollowups(conversationId) {
  try {
    await supabase
      .from('scheduled_followups')
      .update({ status: 'cancelled' })
      .eq('conversation_id', conversationId)
      .eq('status', 'pending');
  } catch (err) {
    console.error('[FlowEngine] Error cancelando seguimientos:', err.message);
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
  // Actualizar último mensaje en conversación
  await supabase.from('conversations').update({
    last_message: content.slice(0, 100),
    last_message_at: new Date().toISOString(),
    ...(direction === 'inbound' ? { unread_count: 1 } : {})
  }).eq('id', conversationId);
}

module.exports = { executeFlow, saveMessage, sendWhatsAppMessage, cancelFollowups };