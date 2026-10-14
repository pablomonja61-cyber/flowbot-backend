const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { translateFlow } = require('../services/flowEngine');

router.use(auth);

// ── Función para regenerar IDs de nodos y edges ──────────────
function regenerateNodeIds(nodes = [], edges = []) {
  const idMap = {};

  const newNodes = nodes.map(node => {
    const newId = `${node.type || 'node'}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    idMap[node.id] = newId;
    return { ...node, id: newId };
  });

  const newEdges = edges.map(edge => {
    const newSource = idMap[edge.source] || edge.source;
    const newTarget = idMap[edge.target] || edge.target;
    const newId = `edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return { ...edge, id: newId, source: newSource, target: newTarget };
  });

  return { nodes: newNodes, edges: newEdges };
}

// ── GET /api/flows ───────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    const { data, error } = await supabase
      .from('flows')
      .select('id, name, description, is_active, created_at, updated_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// ── GET /api/flows/:id ───────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    // Forzar no-cache para que Lovable siempre reciba datos frescos
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');

    const { data, error } = await supabase
      .from('flows')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Flujo no encontrado' });
    res.json(data);
  } catch (err) { next(err); }
});

// ── POST /api/flows ──────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { name, description, nodes = [], edges = [] } = req.body;
    if (!name) return res.status(400).json({ error: 'name es requerido' });

    let finalNodes = nodes;
    let finalEdges = edges;

    if (nodes.length > 0) {
      const regenerated = regenerateNodeIds(nodes, edges);
      finalNodes = regenerated.nodes;
      finalEdges = regenerated.edges;
      console.log(`[Flows] Regenerados ${finalNodes.length} nodos con IDs únicos`);
    }

    const { data, error } = await supabase
      .from('flows')
      .insert({
        id: uuidv4(),
        user_id: req.user.id,
        name,
        description,
        nodes: finalNodes,
        edges: finalEdges,
        is_active: true
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// ── PUT /api/flows/:id ───────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const { name, description, nodes, edges, is_active } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (nodes !== undefined) updates.nodes = nodes;
    if (edges !== undefined) updates.edges = edges;
    if (is_active !== undefined) updates.is_active = is_active;
    const { data, error } = await supabase
      .from('flows')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: 'Flujo no encontrado' });
    res.json(data);
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════
// EXPORTAR / IMPORTAR FLUJOS (archivo JSON)
// ════════════════════════════════════════════════════════════
// Quita referencias que solo existen en la cuenta original (IA elegida,
// número de WhatsApp, otro flujo) para que el archivo sirva en cualquier cuenta.
const CLAVES_PERSONALES = ['ai_config_id', 'aiConfigId', 'connection_id', 'connectionId', 'flowId', 'flow_id', 'targetFlowId'];
function limpiarNodos(nodes = []) {
  let quitadas = 0;
  const limpios = nodes.map(n => {
    if (!n || typeof n !== 'object') return n;
    const data = n.data && typeof n.data === 'object' ? { ...n.data } : n.data;
    if (data && typeof data === 'object') {
      for (const k of CLAVES_PERSONALES) if (k in data && data[k]) { delete data[k]; quitadas++; }
    }
    const { selected, dragging, ...resto } = n;
    return { ...resto, data };
  });
  return { nodes: limpios, quitadas };
}

// ── GET /api/flows/:id/export ────────────────────────────────
// Descarga el flujo como archivo .json
router.get('/:id/export', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('flows').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (error || !data) return res.status(404).json({ error: 'Flujo no encontrado' });
    const { nodes } = limpiarNodos(Array.isArray(data.nodes) ? data.nodes : []);
    const archivo = {
      format: 'ariabot-flow', version: 1, exported_at: new Date().toISOString(),
      flow: { name: data.name, description: data.description || '', nodes, edges: Array.isArray(data.edges) ? data.edges : [] }
    };
    const nombre = String(data.name || 'flujo').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'flujo';
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${nombre}.json"`);
    res.set('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(JSON.stringify(archivo, null, 2));
  } catch (err) { next(err); }
});

// ── POST /api/flows/import ───────────────────────────────────
// Recibe el contenido del archivo JSON y crea un flujo NUEVO (editable).
// Body: el mismo JSON descargado (o { name, nodes, edges }). Opcional: name para cambiar el nombre.
router.post('/import', async (req, res, next) => {
  try {
    const body = req.body || {};
    const contenido = body.flow || body.data?.flow || body.data || body;
    const nodosIn = contenido.nodes, edgesIn = contenido.edges;
    if (!Array.isArray(nodosIn) || nodosIn.length === 0) {
      return res.status(400).json({ error: 'El archivo no es un flujo válido: no tiene nodos.' });
    }
    if (nodosIn.length > 1000) return res.status(400).json({ error: 'El flujo es demasiado grande (máximo 1000 nodos).' });
    if (nodosIn.some(n => !n || typeof n !== 'object' || !n.id || !n.type)) {
      return res.status(400).json({ error: 'El archivo no es un flujo válido: hay nodos sin id o sin tipo.' });
    }
    const ids = new Set(nodosIn.map(n => n.id));
    if (ids.size !== nodosIn.length) return res.status(400).json({ error: 'El archivo no es válido: hay nodos con el mismo id.' });

    const { nodes, quitadas } = limpiarNodos(nodosIn);
    const todasEdges = Array.isArray(edgesIn) ? edgesIn : [];
    const edges = todasEdges.filter(e => e && ids.has(e.source) && ids.has(e.target));
    const edgesDescartadas = todasEdges.length - edges.length;

    let nombre = String(body.name || contenido.name || 'Flujo importado').trim().slice(0, 120) || 'Flujo importado';
    const { data: existentes } = await supabase.from('flows').select('name').eq('user_id', req.user.id);
    const usados = new Set((existentes || []).map(f => f.name));
    if (usados.has(nombre)) {
      let base = `${nombre} (importado)`, n = 2;
      nombre = base;
      while (usados.has(nombre)) nombre = `${base} ${n++}`;
    }

    const { data, error } = await supabase.from('flows').insert({
      id: uuidv4(), user_id: req.user.id, name: nombre,
      description: String(contenido.description || '').slice(0, 1000),
      nodes, edges, is_active: true
    }).select().single();
    if (error) throw error;

    const avisos = [];
    if (quitadas > 0) avisos.push('Algunos nodos tenían una IA, número u otro flujo de la cuenta original. Se quitaron: vuelve a elegirlos.');
    if (edgesDescartadas > 0) avisos.push(`${edgesDescartadas} conexión(es) apuntaban a nodos que no existen y se descartaron.`);
    res.status(201).json({ ...data, warnings: avisos });
  } catch (err) { next(err); }
});

// ── POST /api/flows/:id/translate ────────────────────────────
// Traduce todos los textos de un flujo (mensajes, botones, nombres
// de caminos) a otro idioma, usando la IA ya configurada del
// usuario. Crea un flujo NUEVO — nunca modifica el original.
router.post('/:id/translate', async (req, res, next) => {
  try {
    const { language } = req.body; // 'en' | 'pt' | 'es'
    const nuevoFlow = await translateFlow(req.user.id, req.params.id, language);
    res.status(201).json(nuevoFlow);
  } catch (err) { next(err); }
});

// ── DELETE /api/flows/:id ────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('flows')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/flows/generate-variations ──────────────────────
// Anti-Baneo: genera N variaciones del mismo mensaje, con las mismas
// palabras clave/información pero redactadas distinto — así el bot
// no manda SIEMPRE el texto idéntico a todos, que es uno de los
// patrones que WhatsApp usa para detectar bots y banear números.
router.post('/generate-variations', async (req, res, next) => {
  try {
    const { text, count } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'text es requerido' });
    }
    const n = Math.min(Math.max(parseInt(count) || 1, 1), 10);

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GROQ_API_KEY no configurada en el servidor' });
    }

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'openai/gpt-oss-120b',
        max_tokens: 1500,
        temperature: 0.9,
        messages: [{
          role: 'user',
          content: `Genera ${n} variaciones distintas del siguiente mensaje de WhatsApp. Deben conservar EXACTAMENTE el mismo significado, información y datos (no inventes precios, nombres, ni datos nuevos que no estén en el original), pero con palabras, orden y estructura de frase diferentes en cada una, para que no parezcan el mismo mensaje copiado. Si el original usa formato de WhatsApp (*negrita*, _cursiva_, emojis), consérvalo en las variaciones.

Mensaje original:
"""
${text}
"""

Responde SOLO con un array JSON de ${n} strings, sin explicación ni texto adicional, sin bloque de código markdown. Formato exacto:
["variación 1", "variación 2"]`
        }]
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    let raw = response.data?.choices?.[0]?.message?.content?.trim() || '[]';
    // Por si acaso el modelo devuelve razonamiento envuelto en <think>
    // antes del JSON — se limpia antes de intentar parsearlo.
    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();

    let variations;
    try {
      variations = JSON.parse(raw);
    } catch (e) {
      console.error('[Variaciones] La IA no devolvió JSON válido:', raw.slice(0, 200));
      return res.status(502).json({ error: 'La IA no pudo generar las variaciones, intenta de nuevo' });
    }

    if (!Array.isArray(variations)) {
      return res.status(502).json({ error: 'Respuesta inesperada de la IA' });
    }

    res.json({ variations });
  } catch (err) {
    console.error('[Variaciones] Error:', err.response?.data || err.message);
    next(err);
  }
});

module.exports = router;