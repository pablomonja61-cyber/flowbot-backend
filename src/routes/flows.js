const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

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
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
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