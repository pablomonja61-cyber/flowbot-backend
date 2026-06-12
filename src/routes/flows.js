const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');

// Todos los endpoints requieren auth
router.use(auth);

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
// Body: { name, description, nodes: [...], edges: [...] }
router.post('/', async (req, res, next) => {
  try {
    const { name, description, nodes = [], edges = [] } = req.body;
    if (!name) return res.status(400).json({ error: 'name es requerido' });

    const { data, error } = await supabase
      .from('flows')
      .insert({
        id: uuidv4(),
        user_id: req.user.id,
        name,
        description,
        nodes,   // array de nodos (JSON)
        edges,   // array de conexiones (JSON)
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
