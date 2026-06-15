const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');

router.use(auth);

// ── Función para regenerar IDs de nodos y edges ──────────────
function regenerateNodeIds(nodes = [], edges = []) {
  const idMap = {}; // oldId -> newId

  // Generar nuevos IDs para cada nodo
  const newNodes = nodes.map(node => {
    const newId = `${node.type || 'node'}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    idMap[node.id] = newId;
    return { ...node, id: newId };
  });

  // Actualizar edges con los nuevos IDs
  const newEdges = edges.map(edge => {
    const newSource = idMap[edge.source] || edge.source;
    const newTarget = idMap[edge.target] || edge.target;
    const newId = `edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return {
      ...edge,
      id: newId,
      source: newSource,
      target: newTarget
    };
  });

  return { nodes: newNodes, edges: newEdges };
}

// ── GET /api/flows ───────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
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
// Si viene con nodes/edges desde importación, regenera IDs
router.post('/', async (req, res, next) => {
  try {
    const { name, description, nodes = [], edges = [], imported = false } = req.body;
    if (!name) return res.status(400).json({ error: 'name es requerido' });

    // Si es importación o tiene nodos, regenerar IDs para evitar colisiones
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

module.exports = router;