const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { cancelFollowups } = require('../services/flowEngine');

const activeSessions = {};

// ════════════════════════════════════════════════════════════
// NUEVO: verifica si esta conversación ya activó algún flujo
// alguna vez (dijo una palabra activadora en el pasado).
// Solo si esto es TRUE se permite usar la IA de dudas como
// fallback. Si es FALSE, el bot debe quedarse en silencio.
// ════════════════════════════════════════════════════════════
async function hasActivatedFlowBaileys(conversationId) {
  const { count } = await supabase
    .from('trigger_executions')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', conversationId);

  return (count || 0) > 0;
}

function getSessionPath(connectionId) {
  const dir = path.join('/tmp', 'baileys_sessions', connectionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, Math.min(ms, 30000)));
}

// ── Guardar mensaje ──────────────────────────────────────────
async function saveMsg(conversationId, content, direction, msgType = 'text', mediaUrl = null) {
  if (!conversationId || !content) return;
  try {
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
  } catch (e) {
    console.error('[Baileys] Error guardando mensaje:', e.message);
  }
}

// ── Enviar texto ─────────────────────────────────────────────
async function sendText(sock, jid, text, conversationId) {
  if (!text || !text.trim()) return;
  try {
    await sock.sendMessage(jid, { text });
    await saveMsg(conversationId, text, 'outbound', 'text');
    console.log(`[Baileys] ✓ Texto: ${text.slice(0, 60)}`);
  } catch (e) {
    console.error('[Baileys] Error enviando texto:', e.message);
  }
}

// ── Enviar imagen ────────────────────────────────────────────
async function sendImage(sock, jid, url, caption, conversationId) {
  if (!url || url.startsWith('data:')) return;
  try {
    await sock.sendMessage(jid, { image: { url }, caption: caption || '' });
    await saveMsg(conversationId, caption || '[Imagen]', 'outbound', 'image', url);
    console.log(`[Baileys] ✓ Imagen enviada`);
  } catch (e) {
    console.error('[Baileys] Error enviando imagen:', e.message);
    if (caption) await sendText(sock, jid, caption, conversationId);
  }
}

// ── Enviar video ─────────────────────────────────────────────
async function sendVideoMsg(sock, jid, url, caption, conversationId) {
  if (!url || url.startsWith('data:')) return;
  try {
    await sock.sendMessage(jid, { video: { url }, caption: caption || '' });
    await saveMsg(conversationId, caption || '[Video]', 'outbound', 'video', url);
    console.log(`[Baileys] ✓ Video enviado`);
  } catch (e) {
    console.error('[Baileys] Error enviando video:', e.message);
  }
}

// ── Enviar audio ─────────────────────────────────────────────
async function sendAudioMsg(sock, jid, url, conversationId, asVoiceNote = false) {
  if (!url || url.startsWith('data:')) return;
  try {
    await sock.sendMessage(jid, { audio: { url }, mimetype: 'audio/mp4', ptt: !!asVoiceNote });
    await saveMsg(conversationId, '[Audio]', 'outbound', 'audio', url);
    console.log(`[Baileys] ✓ Audio enviado`);
  } catch (e) {
    console.error('[Baileys] Error enviando audio:', e.message);
  }
}

// ── Enviar documento (PDF y otros archivos) ────────────────────
async function sendDocumentMsg(sock, jid, url, fileName, conversationId) {
  if (!url || url.startsWith('data:')) return;
  try {
    const nombre = fileName || url.split('/').pop().split('?')[0] || 'documento.pdf';
    const ext = (nombre.split('.').pop() || 'pdf').toLowerCase();
    const mimeMap = {
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      zip: 'application/zip'
    };
    const mimetype = mimeMap[ext] || 'application/octet-stream';
    await sock.sendMessage(jid, { document: { url }, mimetype, fileName: nombre });
    await saveMsg(conversationId, `[Documento: ${nombre}]`, 'outbound', 'document', url);
    console.log(`[Baileys] ✓ Documento enviado: ${nombre}`);
  } catch (e) {
    console.error('[Baileys] Error enviando documento:', e.message);
  }
}

// ════════════════════════════════════════════════════════════
// RESPONDER CON IA
// ════════════════════════════════════════════════════════════
async function respondWithAIBaileys(userId, sock, jid, userMessage, conversationId) {
  console.log(`[Baileys AI] Intentando responder con IA para user: ${userId}`);
  try {
    const { data: convData } = await supabase
      .from('conversations')
      .select('ai_config_id, active_price')
      .eq('id', conversationId)
      .single();

    let aiConfig = null;

    if (convData?.ai_config_id) {
      const { data: c } = await supabase
        .from('ai_config')
        .select('*')
        .eq('id', convData.ai_config_id)
        .single();
      if (c) aiConfig = c;
    }

    if (!aiConfig) {
      const { data: c } = await supabase
        .from('ai_config')
        .select('*')
        .eq('user_id', userId)
        .eq('is_active', true)
        .single();
      if (c) aiConfig = c;
    }

    if (!aiConfig) {
      console.log('[Baileys AI] No hay configuración de IA activa para este usuario');
      return;
    }

    console.log(`[Baileys AI] Usando config: ${aiConfig.name || aiConfig.id}`);

    let systemPrompt = aiConfig.system_prompt ||
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

    const apiKey = aiConfig.groq_api_key || process.env.GROQ_API_KEY;
    const model = aiConfig.model || 'meta-llama/llama-4-scout-17b-16e-instruct';

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model, max_tokens: 500, messages },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const aiResponse = response.data.choices[0].message.content;
    console.log(`[Baileys AI] Respuesta: ${aiResponse.slice(0, 80)}`);
    await sendText(sock, jid, aiResponse, conversationId);

  } catch (err) {
    console.error('[Baileys AI] Error:', err.response?.data || err.message);
  }
}

// ════════════════════════════════════════════════════════════
// MOTOR DE FLUJO PARA BAILEYS
// ════════════════════════════════════════════════════════════
async function executeFlowBaileys(flowId, sock, jid, contactPhone, userMessage, conversationId, startNodeId = null) {
  const { data: flow } = await supabase.from('flows').select('*').eq('id', flowId).single();
  if (!flow?.nodes?.length) {
    console.log('[Baileys Flow] Flujo no encontrado o sin nodos');
    return;
  }

  const nodeMap = {};
  flow.nodes.forEach(n => { nodeMap[n.id] = n; });

  const edgeMap = {};
  (flow.edges || []).forEach(e => {
    if (!edgeMap[e.source]) edgeMap[e.source] = [];
    edgeMap[e.source].push({ target: e.target, handle: e.sourceHandle || 'default' });
  });

  let currentNodeId = startNodeId;
  if (!currentNodeId) {
    const startNode = flow.nodes.find(n => n.type === 'start' || n.type === 'trigger');
    if (!startNode) return;
    const firstEdge = edgeMap[startNode.id]?.[0];
    currentNodeId = firstEdge?.target;
  }

  while (currentNodeId) {
    const node = nodeMap[currentNodeId];
    if (!node) {
      console.log(`[Baileys Flow] Nodo ${currentNodeId} no encontrado, terminando`);
      break;
    }

    console.log(`[Baileys Flow] → Nodo: ${node.type} (${node.id})`);

    let shouldPause = false;

    switch (node.type) {

      case 'message':
      case 'content': {
        const items = node.data?.items || [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const tipo = (item.type || '').toLowerCase();

          if (tipo === 'interval') {
            const seconds = Math.min(item.seconds || 1, 30);
            console.log(`[Baileys Flow] Intervalo: ${seconds}s`);
            await sleep(seconds * 1000);
            continue;
          }

          if (tipo === 'text' || tipo === 'texto') {
            const text = item.text || item.content || '';
            if (text) await sendText(sock, jid, text, conversationId);
          } else if (tipo === 'image' || tipo === 'imagen') {
            await sendImage(sock, jid, item.url || '', item.caption || '', conversationId);
          } else if (tipo === 'video') {
            await sendVideoMsg(sock, jid, item.url || '', item.caption || item.description || '', conversationId);
          } else if (tipo === 'audio') {
            await sendAudioMsg(sock, jid, item.url || '', conversationId, !!item.asVoiceNote);
          } else if (tipo === 'doc' || tipo === 'document' || tipo === 'documento') {
            await sendDocumentMsg(sock, jid, item.url || '', item.fileName || item.name || '', conversationId);
          }

          await sleep(600);
        }

        if (node.data?.esperarRespuesta) {
          await supabase.from('conversations').update({
            current_flow_id: flowId,
            current_node_id: node.id,
            flow_active: true
          }).eq('id', conversationId);
          console.log(`[Baileys Flow] ⏸ Pausado en ${node.id} (texto) esperando respuesta`);
          shouldPause = true;
        }
        break;
      }

      case 'api':
      case 'buttons':
      case 'api_message': {
        const text = node.data?.body || node.data?.text || '';
        const buttons = node.data?.buttons || [];
        const headerImage = node.data?.headerType === 'Imagen' ? (node.data?.headerImage || '') : '';

        if (headerImage) {
          await sendImage(sock, jid, headerImage, '', conversationId);
          await sleep(800);
        }

        let fullText = text;
        if (buttons.length > 0) {
          fullText += '\n\n' + buttons.map((b, i) => `${i + 1}. ${b}`).join('\n');
        }
        if (fullText) await sendText(sock, jid, fullText, conversationId);

        if (buttons.length > 0) {
          await supabase.from('conversations').update({
            current_flow_id: flowId,
            current_node_id: node.id,
            flow_active: true
          }).eq('id', conversationId);

          console.log(`[Baileys Flow] ⏸ Pausado en ${node.id} esperando selección de botón`);
          shouldPause = true;
        }
        break;
      }

      case 'ai':
      case 'ai_agent': {
        const { data: conv } = await supabase
          .from('conversations')
          .select('user_id')
          .eq('id', conversationId)
          .single();
        if (conv?.user_id) {
          await respondWithAIBaileys(conv.user_id, sock, jid, userMessage, conversationId);
        }

        // Si tiene caminos de ruteo configurados, se pausa aquí y
        // espera la respuesta del cliente para decidir el camino.
        if (node.data?.paths?.length > 0) {
          await supabase.from('conversations').update({
            current_flow_id: flowId,
            current_node_id: node.id,
            flow_active: true
          }).eq('id', conversationId);
          console.log(`[Baileys Flow] ⏸ Pausado en ${node.id} (Agente IA) esperando respuesta para elegir camino`);
          shouldPause = true;
        }
        break;
      }

      case 'delay': {
        const seconds = Math.min(node.data?.seconds || 3, 30);
        console.log(`[Baileys Flow] Delay: ${seconds}s`);
        await sleep(seconds * 1000);
        break;
      }

      case 'followup':
      case 'delay_followup': {
        const seguimientos = node.data?.seguimientos || [];
        for (const seg of seguimientos) {
          const minutos = seg.tiempo_minutos || 0;
          const precio = seg.precio || '';
          if (minutos > 0) {
            const sendAt = new Date(Date.now() + minutos * 60 * 1000).toISOString();
            const connIdForSock = Object.keys(activeSessions).find(cid => activeSessions[cid] === sock) || null;
            await supabase.from('scheduled_followups').insert({
              id: uuidv4(),
              conversation_id: conversationId,
              connection_id: connIdForSock,
              contact_phone: contactPhone,
              followup_data: seg,
              status: 'pending',
              send_at: sendAt,
              created_at: new Date().toISOString()
            });
            console.log(`[Baileys Flow] Seguimiento programado para ${minutos} min (conexión: ${connIdForSock})`);
          } else {
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

      case 'notification':
      case 'notify': {
        const notifyPhone = (node.data?.phone || '').replace(/\D/g, '');
        const msg = (node.data?.message || '').replace('{{phone}}', contactPhone);
        if (notifyPhone && msg) {
          try {
            await sock.sendMessage(`${notifyPhone}@s.whatsapp.net`, { text: msg });
          } catch (e) {}
        }
        break;
      }

      case 'end':
        console.log('[Baileys Flow] Fin del flujo');
        currentNodeId = null;
        continue;
    }

    if (shouldPause) break;

    const nextEdges = edgeMap[currentNodeId] || [];
    const defaultEdge = nextEdges.find(e => e.handle === 'default' || !e.handle) || nextEdges[0];
    currentNodeId = defaultEdge?.target || null;
  }
}

// ════════════════════════════════════════════════════════════
// RESOLVER CAMINO DE UN NODO "AGENTE IA" (con paths configurados)
// Primero intenta match directo de texto (rápido, sin costo de IA).
// Si no hay match claro, usa IA para clasificar la respuesta.
// ════════════════════════════════════════════════════════════
async function resolveAIPathBaileys(flow, pausedNode, paths, userResponse, sock, jid, contactPhone, conversationId, flowId) {
  const pausedNodeId = pausedNode.id;
  const normalizedResponse = userResponse.toLowerCase().replace(/[^a-z0-9áéíóúñ ]/g, '').trim();

  let matchedIndex = paths.findIndex(p => {
    const label = (p.label || '').toLowerCase().replace(/[^a-z0-9áéíóúñ ]/g, '').trim();
    return label && (normalizedResponse.includes(label) || label.includes(normalizedResponse));
  });

  if (matchedIndex === -1) {
    matchedIndex = await classifyResponseWithAI(userResponse, paths, pausedNode.data?.ai_config_id);
  }

  if (matchedIndex === -1) {
    console.log(`[Baileys Flow] "${userResponse}" no coincide con ningún camino de ${pausedNodeId}`);
    if (pausedNode.data?.respondIfNoMatch !== false) {
      const { data: conv } = await supabase.from('conversations').select('user_id').eq('id', conversationId).single();
      if (conv?.user_id) {
        await respondWithAIBaileys(conv.user_id, sock, jid, userResponse, conversationId);
      }
    }
    // Se mantiene pausado en el mismo nodo para que el cliente pueda reintentar
    return true;
  }

  const matchedHandle = `path-${matchedIndex}`;
  const matchedEdge = (flow.edges || []).find(e => e.source === pausedNodeId && e.sourceHandle === matchedHandle);

  if (!matchedEdge) {
    console.log(`[Baileys Flow] Camino "${matchedHandle}" (${paths[matchedIndex]?.label}) no tiene edge conectado en el editor`);
    return true;
  }

  await supabase.from('conversations').update({
    current_node_id: null,
    current_flow_id: null
  }).eq('id', conversationId);

  console.log(`[Baileys Flow] ▶ Camino elegido: "${paths[matchedIndex].label}" → ${matchedEdge.target}`);
  await executeFlowBaileys(flowId, sock, jid, contactPhone, userResponse, conversationId, matchedEdge.target);
  return true;
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
    const model = aiConfig?.model || 'meta-llama/llama-4-scout-17b-16e-instruct';
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
    console.error('[Baileys Flow] Error clasificando camino con IA:', err.message);
    return -1;
  }
}

// ════════════════════════════════════════════════════════════
// REVISAR SI OTRO TRIGGER APLICA (para nodos con "Activar otros flujos")
// Se usa cuando un flujo está pausado esperando respuesta, pero el
// nodo tiene el toggle "triggerOtherFlows" activado — en ese caso,
// antes de tratar el mensaje como respuesta al nodo, se revisa si
// coincide con la palabra activadora de OTRO flujo.
// ════════════════════════════════════════════════════════════
async function checkOtherFlowTrigger(userId, connectionId, contactPhone, userMessage) {
  const normalizedMsg = (userMessage || '').toLowerCase().trim();
  if (!normalizedMsg) return null;

  const { data: triggers } = await supabase
    .from('triggers')
    .select('*')
    .eq('user_id', userId)
    .eq('connection_id', connectionId)
    .eq('is_active', true);

  const matched = (triggers || []).find(t => {
    const kw = (t.keyword || '').toLowerCase().trim();
    return kw && (normalizedMsg === kw || normalizedMsg.includes(kw));
  });

  if (!matched) return null;

  if (!matched.is_repeatable) {
    const { count } = await supabase
      .from('trigger_executions')
      .select('*', { count: 'exact', head: true })
      .eq('trigger_id', matched.id)
      .eq('contact_phone', contactPhone);
    if (count > 0) return null; // ya se ejecutó y no es repetible
  }

  return matched;
}

// ════════════════════════════════════════════════════════════
// CONTINUAR FLUJO DESDE RESPUESTA DE BOTÓN
// ════════════════════════════════════════════════════════════
async function continueFlowFromButtonBaileys(flowId, pausedNodeId, userResponse, sock, jid, contactPhone, conversationId) {
  const { data: flow } = await supabase.from('flows').select('*').eq('id', flowId).single();
  if (!flow) return false;

  const nodeMap = {};
  flow.nodes.forEach(n => { nodeMap[n.id] = n; });

  const pausedNode = nodeMap[pausedNodeId];
  if (!pausedNode) return false;

  // ── Nodo Agente IA con "caminos de ruteo" configurados ────────
  // La IA (o un match simple de texto) decide cuál camino sigue
  // según la respuesta del cliente. Funciona igual en QR y API,
  // porque no depende de botones nativos — solo interpreta texto.
  if (pausedNode.type === 'ai' || pausedNode.type === 'ai_agent') {
    const paths = pausedNode.data?.paths || [];
    if (paths.length > 0) {
      const handled = await resolveAIPathBaileys(
        flow, pausedNode, paths, userResponse,
        sock, jid, contactPhone, conversationId, flowId
      );
      return handled;
    }
  }

  // Si el nodo pausado es de texto normal (no botones API), simplemente
  // avanza al siguiente nodo, pasando la respuesta del cliente como
  // userMessage para que el siguiente nodo (ej. Agente IA) la use.
  if (pausedNode.type !== 'buttons' && pausedNode.type !== 'api_message' && pausedNode.type !== 'api') {
    const nextEdges = (flow.edges || []).filter(e => e.source === pausedNodeId);
    const nextEdge = nextEdges.find(e => !e.sourceHandle || e.sourceHandle === 'default') || nextEdges[0];
    if (!nextEdge) return false;

    await supabase.from('conversations').update({
      current_node_id: null,
      current_flow_id: null
    }).eq('id', conversationId);

    console.log(`[Baileys Flow] ▶ Continuando (texto) → ${nextEdge.target}`);
    await executeFlowBaileys(flowId, sock, jid, contactPhone, userResponse, conversationId, nextEdge.target);
    return true;
  }

  const buttons = pausedNode.data?.buttons || [];
  if (!buttons.length) return false;

  const response = userResponse.toLowerCase().trim();
  let matchedHandle = null;

  const numMatch = response.match(/^(\d+)/);
  if (numMatch) {
    const idx = parseInt(numMatch[1]) - 1;
    if (idx >= 0 && idx < buttons.length) {
      matchedHandle = `output-btn-${idx}`;
      console.log(`[Baileys Flow] Botón por número: ${idx + 1} → ${matchedHandle}`);
    }
  }

  if (!matchedHandle) {
    for (let i = 0; i < buttons.length; i++) {
      const btnText = buttons[i].toLowerCase().replace(/[^a-z0-9áéíóúñ ]/g, '').trim();
      const respText = response.replace(/[^a-z0-9áéíóúñ ]/g, '').trim();
      if (respText.includes(btnText) || btnText.includes(respText)) {
        matchedHandle = `output-btn-${i}`;
        console.log(`[Baileys Flow] Botón por texto: "${buttons[i]}" → ${matchedHandle}`);
        break;
      }
    }
  }

  if (!matchedHandle) {
    console.log(`[Baileys Flow] "${userResponse}" no coincide con ningún botón → IA responderá`);
    return false;
  }

  const matchedEdge = (flow.edges || []).find(e =>
    e.source === pausedNodeId && e.sourceHandle === matchedHandle
  );

  if (!matchedEdge) {
    console.log(`[Baileys Flow] No hay edge para ${matchedHandle}`);
    return false;
  }

  await supabase.from('conversations').update({
    current_node_id: null,
    current_flow_id: null
  }).eq('id', conversationId);

  console.log(`[Baileys Flow] ▶ Continuando: ${matchedHandle} → ${matchedEdge.target}`);
  await executeFlowBaileys(flowId, sock, jid, contactPhone, userResponse, conversationId, matchedEdge.target);
  return true;
}

// ── Enviar contenido de seguimiento ─────────────────────────
async function sendFollowupContent(sock, jid, contenido, conversationId) {
  const tipo = (contenido.tipo || '').toLowerCase();

  if (tipo === 'texto') {
    await sendText(sock, jid, contenido.texto || contenido.mensaje || '', conversationId);
  } else if (tipo === 'imagen') {
    await sendImage(sock, jid, contenido.url || '', contenido.caption || contenido.descripcion || '', conversationId);
  } else if (tipo === 'pausa') {
    await sleep((contenido.segundos || 1) * 1000);
  } else if (tipo === 'botones') {
    if (contenido.imagen_cabecera) {
      await sendImage(sock, jid, contenido.imagen_cabecera, '', conversationId);
      await sleep(800);
    }
    const botones = contenido.botones || [];
    let fullText = contenido.mensaje || '';
    if (botones.length > 0) {
      fullText += '\n\n' + botones.map((b, i) => `${i + 1}. ${b}`).join('\n');
    }
    if (fullText) await sendText(sock, jid, fullText, conversationId);
  } else if (tipo === 'audio') {
    await sendAudioMsg(sock, jid, contenido.url || '', conversationId, !!contenido.asVoiceNote || !!contenido.notaVoz);
  } else if (tipo === 'video') {
    await sendVideoMsg(sock, jid, contenido.url || '', contenido.caption || contenido.descripcion || '', conversationId);
  } else if (tipo === 'archivo' || tipo === 'documento' || tipo === 'doc') {
    await sendDocumentMsg(sock, jid, contenido.url || '', contenido.fileName || contenido.nombre || '', conversationId);
  }

  await sleep(500);
}

// ════════════════════════════════════════════════════════════
// MOTOR DE SEGUIMIENTOS PROGRAMADOS
// Revisa cada minuto la tabla scheduled_followups y envía los
// que ya cumplieron su hora. Esta es la pieza que antes faltaba:
// los seguimientos se guardaban pero nunca se disparaban.
// ════════════════════════════════════════════════════════════
async function processScheduledFollowups() {
  try {
    const nowIso = new Date().toISOString();

    const { data: due, error } = await supabase
      .from('scheduled_followups')
      .select('*')
      .eq('status', 'pending')
      .lte('send_at', nowIso)
      .limit(50);

    if (error) {
      console.error('[Followups] Error consultando scheduled_followups:', error.message);
      return;
    }

    if (!due || due.length === 0) return;

    console.log(`[Followups] ${due.length} seguimiento(s) pendiente(s) de enviar`);

    for (const item of due) {
      const sock = item.connection_id ? activeSessions[item.connection_id] : null;

      if (!sock) {
        // Sin conexión activa ahora mismo. Si lleva más de 24h vencido,
        // se marca como expirado para no acumularlo indefinidamente;
        // si no, se deja 'pending' para reintentar en el próximo ciclo.
        const horasVencido = (Date.now() - new Date(item.send_at).getTime()) / 3600000;
        if (horasVencido > 24) {
          await supabase.from('scheduled_followups')
            .update({ status: 'expired' })
            .eq('id', item.id);
          console.log(`[Followups] Seguimiento ${item.id} expirado (sin conexión activa por más de 24h)`);
        } else {
          console.log(`[Followups] Seguimiento ${item.id} pendiente — conexión ${item.connection_id} no activa aún`);
        }
        continue;
      }

      try {
        const jid = `${item.contact_phone}@s.whatsapp.net`;
        const seg = item.followup_data || {};

        if (seg.precio) {
          await supabase.from('conversations').update({ active_price: seg.precio }).eq('id', item.conversation_id);
        }

        for (const contenido of seg.contenidos || []) {
          await sendFollowupContent(sock, jid, contenido, item.conversation_id);
        }

        await supabase.from('scheduled_followups')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', item.id);

        console.log(`[Followups] ✅ Seguimiento ${item.id} enviado a ${item.contact_phone}`);
      } catch (sendErr) {
        console.error(`[Followups] Error enviando seguimiento ${item.id}:`, sendErr.message);
        await supabase.from('scheduled_followups')
          .update({ status: 'failed' })
          .eq('id', item.id);
      }
    }
  } catch (err) {
    console.error('[Followups] Error general en processScheduledFollowups:', err.message);
  }
}

// Revisa la tabla cada 60 segundos. Si el proceso se reinicia
// (ej. redeploy en Railway), simplemente retoma en el próximo ciclo
// — nada se pierde porque el estado vive en la base de datos.
setInterval(processScheduledFollowups, 60 * 1000);


async function findMatchingPaymentRule(rules, monto, conversationId) {
  const candidates = (rules || []).filter(r => Math.abs(Number(r.amount) - Number(monto)) < 0.5);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const { data: history } = await supabase
    .from('messages')
    .select('content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(20);

  const recentText = (history || []).map(m => m.content || '').join(' ').toLowerCase();

  for (const rule of candidates) {
    const keywords = (rule.context_keyword || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (keywords.length && keywords.some(kw => recentText.includes(kw))) {
      console.log(`[Payment] Desempate por contexto: regla "${rule.context_keyword}" coincide con la conversación`);
      return rule;
    }
  }

  console.warn(`[Payment] Monto ${monto} coincide con ${candidates.length} reglas y ninguna coincide por contexto — usando la primera`);
  return candidates[0];
}

// ════════════════════════════════════════════════════════════
// BLOQUEO POR PAÍS
// Deduce el país del número de contacto por su prefijo telefónico
// y revisa si el usuario lo tiene bloqueado en `blocked_countries`.
// ════════════════════════════════════════════════════════════
const CALLING_CODE_TO_ISO = [
  // [prefijo, código ISO] — ordenado de más largo a más corto para
  // que el match de prefijo más específico gane primero.
  ['1809', 'DO'], ['1829', 'DO'], ['1849', 'DO'], // Rep. Dominicana (comparte +1 con USA/Canadá)
  ['54', 'AR'], ['55', 'BR'], ['56', 'CL'], ['57', 'CO'], ['58', 'VE'],
  ['51', 'PE'], ['52', 'MX'], ['53', 'CU'],
  ['591', 'BO'], ['592', 'GY'], ['593', 'EC'], ['594', 'GF'], ['595', 'PY'],
  ['596', 'MQ'], ['597', 'SR'], ['598', 'UY'], ['599', 'CW'],
  ['502', 'GT'], ['503', 'SV'], ['504', 'HN'], ['505', 'NI'],
  ['506', 'CR'], ['507', 'PA'], ['501', 'BZ'],
  ['1', 'US'], // fallback genérico para +1 (US/Canadá) si no matchea otro código +1XXX
];

function getCountryCodeFromPhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  // Prueba primero los prefijos más largos (4, luego 3, luego 2, luego 1 dígito)
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
    console.error('[Baileys] Error revisando bloqueo por país:', err.message);
    return false; // ante la duda, no bloquear (evita tumbar el bot por un error de red)
  }
}

// ════════════════════════════════════════════════════════════
// RESOLVER NODO "AGENTE IA" PAUSADO CON CAMINO "PAGO"
// Si la conversación está esperando respuesta en un nodo con un
// camino de tipo Pago, devuelve ese camino para validar contra él
// en vez de la tabla global payment_config/payment_rules.
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
  const paidPaths = paths
    .map((p, index) => ({ path: p, index }))
    .filter(p => p.path.type === 'Pago');

  if (paidPaths.length === 0) return null;

  return { flow, node, paidPaths };
}

// ════════════════════════════════════════════════════════════
// PROCESAR IMAGEN ENTRANTE (comprobante de pago)
// Equivalente a processIncomingImage() de webhook.js, adaptado
// para descargar el archivo con Baileys en vez de la Graph API.
// ════════════════════════════════════════════════════════════
async function processIncomingImageBaileys(connectionId, userId, sock, contactPhone, rawMsg, rawJid, contactName) {
  const jid = rawJid || `${contactPhone}@s.whatsapp.net`;

  if (await isCountryBlocked(userId, contactPhone)) {
    console.log(`[Baileys] 🚫 País bloqueado — ignorando imagen de ${contactPhone}`);
    return;
  }

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
        contact_name: contactName || contactPhone,
        status: 'active',
        unread_count: 1,
        flow_active: true,
        last_message: '[Imagen]',
        last_message_at: new Date().toISOString()
      })
      .select()
      .single();
    conversation = newConv;
  }

  if (!conversation) return;

  if (conversation.is_blocked) {
    console.log(`[Baileys Payment] Conversación ${conversation.id} bloqueada — ignorando imagen`);
    return;
  }

  // Descargar la imagen real usando Baileys
  let imageBuffer = null;
  try {
    imageBuffer = await downloadMediaMessage(
      rawMsg,
      'buffer',
      {},
      { logger: pino({ level: 'silent' }) }
    );
  } catch (err) {
    console.error('[Baileys Payment] Error descargando imagen:', err.message);
  }

  const mimeType = rawMsg.message?.imageMessage?.mimetype || 'image/jpeg';

  // Subir la imagen a Supabase Storage para poder mostrarla luego en la app
  let publicMediaUrl = null;
  if (imageBuffer) {
    try {
      const ext = (mimeType.split('/')[1] || 'jpg').split(';')[0];
      const filePath = `${userId}/${conversation.id}/${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from('media')
        .upload(filePath, imageBuffer, { contentType: mimeType, upsert: false });

      if (uploadError) {
        console.error('[Baileys Payment] Error subiendo imagen a Storage:', uploadError.message);
      } else {
        const { data: publicUrlData } = supabase.storage.from('media').getPublicUrl(filePath);
        publicMediaUrl = publicUrlData?.publicUrl || null;
      }
    } catch (upErr) {
      console.error('[Baileys Payment] Error subiendo imagen a Storage:', upErr.message);
    }
  }

  await saveMsg(conversation.id, '[Imagen recibida - posible comprobante]', 'inbound', 'image', publicMediaUrl);

  if (conversation.flow_active === false) {
    console.log(`[Baileys Payment] Flujo desactivado para ${conversation.id} — bot no responde más`);
    return;
  }

  if (!imageBuffer) {
    console.log('[Baileys Payment] No se pudo descargar la imagen, se omite el análisis de pago');
    return;
  }

  const base64Image = imageBuffer.toString('base64');

  // ── Buscar si hay caminos "Pago" activos en el flujo pausado ──
  const paidPathInfo = await resolvePaidPathNode(conversation);

  const { data: paymentConfig } = await supabase
    .from('payment_config')
    .select('*')
    .eq('user_id', userId)
    .single();

  const msgConfirmacion = paymentConfig?.msg_confirmacion ||
    'Gracias por tu pago. Validaremos el comprobante y en breve te enviaremos el acceso.';
  const msgNoValido = paymentConfig?.msg_no_valido ||
    'Disculpa, no pudimos validar el comprobante. Por favor envía una foto más clara.';

  const apiKey = process.env.GROQ_API_KEY;
  const hoyLima = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());

  // Instrucción extra de "Validar" (texto libre) de cualquiera de los
  // caminos de pago del nodo, para que la IA la revise en la misma pasada.
  const validarExtra = (paidPathInfo?.paidPaths || [])
    .map(p => p.path.validar)
    .filter(Boolean)[0];

  let analysisResult = null;

  try {
    const visionResponse = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        max_tokens: 400,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Analiza esta imagen. ¿Es un comprobante de pago (Yape, Plin, transferencia bancaria u otro)?
Si lo es, extrae:
- monto: el monto exacto pagado (solo el número, sin moneda)
- titular_destino: el nombre del destinatario/titular al que se realizó el pago (puede aparecer como "Destino", "Para", "Titular", "Nombre")
- numero_operacion: el número de operación/transacción del comprobante, si aparece
- fecha_es_hoy: true si la fecha del comprobante es hoy (${hoyLima}, zona horaria Perú), false si es una fecha anterior, null si no se ve fecha
- estado_pago: "confirmado" si el comprobante muestra un pago exitoso/completado, "pendiente" si muestra un estado pendiente/en proceso, "desconocido" si no es claro
${validarExtra ? `- cumple_validacion_extra: true/false según si la imagen cumple con este criterio adicional: "${validarExtra}"` : ''}

Responde SOLO en formato JSON exacto, sin texto adicional:
{"es_comprobante": true/false, "monto": numero_o_null, "titular_destino": "nombre_o_null", "numero_operacion": "texto_o_null", "fecha_es_hoy": true/false/null, "estado_pago": "confirmado/pendiente/desconocido"${validarExtra ? ', "cumple_validacion_extra": true/false' : ''}}`
              },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64Image}` }
              }
            ]
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const rawText = visionResponse.data.choices[0].message.content.trim();
    console.log('[Baileys Payment Vision] Respuesta IA:', rawText);

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      analysisResult = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    console.error('[Baileys Payment Vision error]', err.response?.data || err.message);
  }

  if (!analysisResult || !analysisResult.es_comprobante) {
    console.log('[Baileys Payment] No es un comprobante válido');
    await sendText(sock, jid, msgNoValido, conversation.id);
    return;
  }

  const monto = analysisResult.monto;
  console.log(`[Baileys Payment] Comprobante detectado, monto: ${monto}`);

  // ── Camino A: hay un flujo pausado con camino(s) "Pago" ──
  if (paidPathInfo && paidPathInfo.paidPaths.length > 0) {
    // Elegir el camino cuyo monto coincida (si hay varios, ej. $5 y $7).
    // Si solo hay uno, se usa ese directamente.
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

    // Solo se revisa cada criterio si el usuario lo activó en el nodo.
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

    if (path.confirmado === true) {
      if (analysisResult.estado_pago !== 'confirmado') {
        fallas.push('el comprobante no muestra un pago confirmado/exitoso');
      }
    }

    if (path.fecha === true) {
      if (analysisResult.fecha_es_hoy !== true) {
        fallas.push('la fecha del comprobante no es de hoy (posible captura antigua o reutilizada)');
      }
    }

    if (validarExtra && path.validar) {
      if (analysisResult.cumple_validacion_extra !== true) {
        fallas.push(`no cumple con el criterio adicional configurado: "${path.validar}"`);
      }
    }

    let reusado = false;
    if (path.reuso === true && analysisResult.numero_operacion) {
      try {
        const { data: existente } = await supabase
          .from('used_payment_operations')
          .select('id')
          .eq('user_id', userId)
          .eq('numero_operacion', analysisResult.numero_operacion)
          .maybeSingle();
        if (existente) {
          reusado = true;
          fallas.push('este comprobante ya fue usado anteriormente (número de operación repetido)');
        }
      } catch (err) {
        console.log('[Baileys Payment] Tabla used_payment_operations no disponible, se omite chequeo de reúso:', err.message);
      }
    }

    if (fallas.length > 0) {
      console.log(`[Baileys Payment] Validación falló: ${fallas.join(' | ')}`);
      if (paidPathInfo.node?.data?.respondIfNoMatch !== false) {
        const contextoFalla = `El cliente envió un comprobante de pago, pero la validación falló por: ${fallas.join('; ')}. Explícale amablemente por qué no se pudo validar y qué debe hacer.`;
        await respondWithAIBaileys(userId, sock, jid, contextoFalla, conversation.id);
      } else {
        console.log('[Baileys Payment] respondIfNoMatch desactivado — no se envía respuesta, queda pausado');
      }
      return; // se queda pausado en el mismo nodo, puede reintentar
    }

    console.log(`[Baileys Payment] Pago validado vía flujo — continuando por el camino "Pago"`);
    await sendText(sock, jid, msgConfirmacion, conversation.id);

    if (path.reuso === true && analysisResult.numero_operacion && !reusado) {
      try {
        await supabase.from('used_payment_operations').insert({
          user_id: userId,
          numero_operacion: analysisResult.numero_operacion,
          conversation_id: conversation.id
        });
      } catch (err) {
        console.log('[Baileys Payment] No se pudo registrar número de operación (tabla puede no existir aún):', err.message);
      }
    }

    const matchedHandle = `path-${selected.index}`;
    const matchedEdge = (paidPathInfo.flow.edges || []).find(
      e => e.source === paidPathInfo.node.id && e.sourceHandle === matchedHandle
    );

    await supabase.from('conversations').update({
      is_sale: true,
      sale_amount: monto,
      sale_at: new Date().toISOString(),
      current_node_id: null,
      current_flow_id: null
    }).eq('id', conversation.id);

    try {
      await cancelFollowups(conversation.id);
    } catch (e) {
      console.error('[Baileys Payment] Error cancelando seguimientos:', e.message);
    }

    if (matchedEdge) {
      await executeFlowBaileys(
        paidPathInfo.flow.id || conversation.current_flow_id,
        sock, jid, contactPhone, '', conversation.id, matchedEdge.target
      );
    } else {
      console.log(`[Baileys Payment] Camino "${matchedHandle}" no tiene edge conectado en el editor`);
    }

    console.log(`[Baileys Payment] Conversación ${conversation.id} marcada como venta vía flujo.`);
    return;
  }

  // ── Camino B (legado): sin flujo pausado, usar payment_config/payment_rules global ──
  if (monto === null || monto === undefined) {
    await sendText(sock, jid, msgConfirmacion, conversation.id);
    return;
  }

  const titularEsperadoLegado = (paymentConfig?.titular || '').toLowerCase().trim();
  if (titularEsperadoLegado) {
    const titularDetectado = (analysisResult.titular_destino || '').toLowerCase().trim();
    if (titularDetectado && !titularDetectado.includes(titularEsperadoLegado) && !titularEsperadoLegado.includes(titularDetectado)) {
      console.log('[Baileys Payment] (legado) Titular no coincide — rechazando comprobante');
      await sendText(sock, jid,
        'Disculpa, el comprobante no está dirigido a nuestra cuenta. Por favor verifica el destinatario e intenta de nuevo.',
        conversation.id);
      return;
    }
  }

  await sendText(sock, jid, msgConfirmacion, conversation.id);

  const { data: rules } = await supabase
    .from('payment_rules')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true);

  const matchedRule = await findMatchingPaymentRule(rules, monto, conversation.id);

  if (!matchedRule) {
    console.log(`[Baileys Payment] No hay regla configurada para monto ${monto}`);
    return;
  }

  console.log(`[Baileys Payment] Regla encontrada para monto ${monto}, enviando acceso`);
  await sendText(sock, jid, matchedRule.access_message, conversation.id);

  await supabase.from('conversations').update({
    is_sale: true,
    sale_amount: monto,
    sale_at: new Date().toISOString(),
    flow_active: false
  }).eq('id', conversation.id);

  try {
    await cancelFollowups(conversation.id);
  } catch (e) {
    console.error('[Baileys Payment] Error cancelando seguimientos:', e.message);
  }

  console.log(`[Baileys Payment] Conversación ${conversation.id} marcada como venta (sistema legado).`);
}

// ════════════════════════════════════════════════════════════
// PROCESAR MENSAJE ENTRANTE
// ════════════════════════════════════════════════════════════
async function processBaileysMessage(connectionId, userId, sock, contactPhone, userMessage, isImage, rawMsg, rawJid, contactName) {
  const jid = rawJid || `${contactPhone}@s.whatsapp.net`;

  if (await isCountryBlocked(userId, contactPhone)) {
    console.log(`[Baileys] 🚫 País bloqueado — ignorando mensaje de ${contactPhone}`);
    return;
  }

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
        contact_name: contactName || contactPhone,
        status: 'active',
        unread_count: 1,
        flow_active: true,
        last_message: isImage ? '[Imagen]' : userMessage.slice(0, 100),
        last_message_at: new Date().toISOString()
      })
      .select()
      .single();
    conversation = newConv;
  } else if (contactName && contactName !== contactPhone && conversation.contact_name === conversation.contact_phone) {
    // Actualizar nombre si antes solo tenía el número
    await supabase.from('conversations').update({ contact_name: contactName }).eq('id', conversation.id);
  }

  if (!conversation) return;
  if (conversation.is_blocked) return;

  await saveMsg(conversation.id, isImage ? '[Imagen recibida]' : userMessage, 'inbound', isImage ? 'image' : 'text');

  if (conversation.flow_active === false) {
    // El flujo fue desactivado (ej. después de una venta) — el bot
    // se queda en silencio, igual que en webhook.js (API oficial).
    console.log(`[Baileys] Flujo desactivado para ${conversation.id} — bot no responde más`);
    return;
  }

  if (conversation.current_flow_id && conversation.current_node_id) {
    console.log(`[Baileys] Flujo pausado detectado en nodo: ${conversation.current_node_id}`);

    // Si el nodo pausado tiene "Activar otros flujos" activado, revisar
    // primero si el mensaje coincide con la palabra activadora de OTRO
    // flujo antes de tratarlo como respuesta al nodo actual.
    const { data: pausedFlowData } = await supabase
      .from('flows')
      .select('nodes')
      .eq('id', conversation.current_flow_id)
      .single();
    const pausedNode = (pausedFlowData?.nodes || []).find(n => n.id === conversation.current_node_id);

    if (pausedNode?.data?.triggerOtherFlows === true) {
      const otherTrigger = await checkOtherFlowTrigger(userId, connectionId, contactPhone, userMessage);
      if (otherTrigger) {
        console.log(`[Baileys] "Activar otros flujos" activo — trigger "${otherTrigger.keyword}" coincide, abandonando flujo pausado`);
        await supabase.from('conversations').update({
          current_flow_id: null,
          current_node_id: null
        }).eq('id', conversation.id);

        const { data: newFlow } = await supabase
          .from('flows')
          .select('nodes')
          .eq('id', otherTrigger.flow_id)
          .single();
        const startNode = (newFlow?.nodes || []).find(n => n.type === 'start');
        if (startNode) {
          await supabase.from('trigger_executions').insert({
            trigger_id: otherTrigger.id, contact_phone: contactPhone
          });
          await executeFlowBaileys(otherTrigger.flow_id, sock, jid, contactPhone, userMessage, conversation.id, startNode.id);
          return;
        }
      }
    }

    const handled = await continueFlowFromButtonBaileys(
      conversation.current_flow_id,
      conversation.current_node_id,
      userMessage,
      sock, jid, contactPhone,
      conversation.id
    );
    if (handled) return;

    // Está en medio de un flujo pausado (ya activado antes),
    // así que aquí sí es válido usar la IA como fallback.
    console.log(`[Baileys] IA responde duda mientras flujo sigue pausado`);
    await respondWithAIBaileys(userId, sock, jid, userMessage, conversation.id);
    return;
  }

  const normalizedMsg = userMessage.toLowerCase().trim();

  const { data: triggers } = await supabase
    .from('triggers')
    .select('*')
    .eq('user_id', userId)
    .eq('connection_id', connectionId)
    .eq('is_active', true);

  const matchedTrigger = (triggers || []).find(t => {
    const kw = t.keyword.toLowerCase().trim();
    return normalizedMsg === kw || normalizedMsg.includes(kw);
  });

  // Caso 1: el mensaje SÍ coincide con una palabra activadora → ejecutar flujo
  if (matchedTrigger) {
    if (!matchedTrigger.is_repeatable) {
      const { count } = await supabase
        .from('trigger_executions')
        .select('*', { count: 'exact', head: true })
        .eq('trigger_id', matchedTrigger.id)
        .eq('contact_phone', contactPhone);

      if (count > 0) {
        // Ya se ejecutó antes → el flujo ya se activó en algún
        // momento para este contacto, así que sí usamos IA.
        console.log(`[Baileys] Trigger "${matchedTrigger.keyword}" no repetible y ya ejecutado — usando IA fallback`);
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

    console.log(`[Baileys] ▶ Ejecutando trigger "${matchedTrigger.keyword}"`);
    await executeFlowBaileys(matchedTrigger.flow_id, sock, jid, contactPhone, userMessage, conversation.id);
    return;
  }

  // Caso 2: NO coincide con ningún trigger.
  // Solo respondemos con IA si esta conversación YA activó un
  // flujo antes (dijo la palabra clave en algún mensaje previo).
  // Si nunca la dijo, el bot se queda en silencio — no responde nada.
  const yaActivo = await hasActivatedFlowBaileys(conversation.id);

  if (!yaActivo) {
    console.log(`[Baileys] "${normalizedMsg}" no coincide con ningún trigger y la conversación nunca activó un flujo — el bot NO responde`);
    return;
  }

  console.log(`[Baileys] "${normalizedMsg}" no coincide con trigger, pero el flujo ya fue activado antes — usando IA fallback`);
  await respondWithAIBaileys(userId, sock, jid, userMessage, conversation.id);
}

// ════════════════════════════════════════════════════════════
// SESIÓN QR
// ════════════════════════════════════════════════════════════
async function startQRSession(connectionId, userId) {
  try {
    console.log(`[Baileys] Iniciando sesión: ${connectionId}`);

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
          console.log(`[Baileys] QR generado: ${connectionId}`);
        } catch (e) { console.error('[Baileys] Error QR:', e.message); }
      }

      if (connection === 'open') {
        const phoneNumber = sock.user?.id?.split(':')[0] || '';
        console.log(`[Baileys] ✅ Conectado: ${phoneNumber}`);
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
        console.log(`[Baileys] Desconectado: ${statusCode}`);

        await supabase.from('connections').update({
          qr_status: shouldReconnect ? 'reconnecting' : 'disconnected',
          is_active: false
        }).eq('id', connectionId);

        delete activeSessions[connectionId];

        if (shouldReconnect) {
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
        if (rawJid.includes('@g.us')) continue;

        // ── FIX: limpiar @lid y caracteres no numéricos ──────
        let contactPhone = rawJid
          .replace('@s.whatsapp.net', '')
          .replace('@lid', '')
          .replace(/[^0-9]/g, '');

        // Si el JID tiene formato @lid, intentar obtener número real del participant
        if (rawJid.includes('@lid')) {
          const participant = msg.key.participant || '';
          const cleaned = participant
            .replace('@s.whatsapp.net', '')
            .replace('@lid', '')
            .replace(/[^0-9]/g, '');
          if (cleaned) contactPhone = cleaned;
        }

        if (!contactPhone) continue;

        // Nombre real del contacto (pushName de WhatsApp)
        const contactName = msg.pushName || contactPhone;

        const userMessage =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption || '';

        const isImage = !!msg.message.imageMessage;

        console.log(`[Baileys] 📨 Mensaje de ${contactPhone} (${contactName}): "${userMessage}"${isImage ? ' [Imagen]' : ''}`);

        try {
          if (isImage) {
            // Las imágenes se procesan como posible comprobante de
            // pago, sin importar el estado del trigger/flujo actual.
            await processIncomingImageBaileys(connectionId, userId, sock, contactPhone, msg, rawJid, contactName);
          } else {
            await processBaileysMessage(connectionId, userId, sock, contactPhone, userMessage, isImage, msg, rawJid, contactName);
          }
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

async function getQRCode(connectionId) {
  const { data } = await supabase.from('connections').select('qr_code, qr_status, phone_number').eq('id', connectionId).single();
  return data;
}

async function closeQRSession(connectionId) {
  if (activeSessions[connectionId]) {
    try { await activeSessions[connectionId].logout(); } catch (e) {}
    delete activeSessions[connectionId];
  }
  await supabase.from('connections').update({ qr_status: 'disconnected', qr_code: null, is_active: false }).eq('id', connectionId);
}

async function restoreActiveSessions() {
  try {
    const { data: qrConnections } = await supabase
      .from('connections')
      .select('id, user_id')
      .eq('connection_type', 'qr')
      .eq('qr_status', 'connected');

    if (!qrConnections?.length) {
      console.log('[Baileys] No hay sesiones QR para restaurar');
      return;
    }
    console.log(`[Baileys] Restaurando ${qrConnections.length} sesiones...`);
    for (const conn of qrConnections) {
      await startQRSession(conn.id, conn.user_id);
    }
  } catch (err) {
    console.error('[Baileys] Error restaurando sesiones:', err.message);
  }
}

module.exports = { startQRSession, getQRCode, closeQRSession, restoreActiveSessions };