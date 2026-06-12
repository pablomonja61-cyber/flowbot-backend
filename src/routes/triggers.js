const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');

router.use(auth);

// ── GET /api/triggers ────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('triggers')
      .select('*, flows(name)')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// ── POST /api/triggers ───────────────────────────────────────
// Body: { name, keyword, flow_id, connection_id, is_repeatable }
router.post('/', async (req, res, next) => {
  try {
    const { name, keyword, flow_id, connection_id, is_repeatable = true } = req.body;
    if (!name || !keyword || !flow_id || !connection_id) {
      return res.status(400).json({ error: 'name, keyword, flow_id y connection_id son requeridos' });
    }

    // Verificar que el flujo pertenece al usuario
    const { data: flow } = await supabase
      .from('flows')
      .select('id')
      .eq('id', flow_id)
      .eq('user_id', req.user.id)
      .single();
    if (!flow) return res.status(404).json({ error: 'Flujo no encontrado' });

    const { data, error } = await supabase
      .from('triggers')
      .insert({
        id: uuidv4(),
        user_id: req.user.id,
        name,
        keyword: keyword.toLowerCase().trim(),
        flow_id,
        connection_id,
        is_repeatable,
        is_active: true
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// ── PUT /api/triggers/:id ────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const { name, keyword, flow_id, is_active, is_repeatable } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name;
    if (keyword !== undefined) updates.keyword = keyword.toLowerCase().trim();
    if (flow_id !== undefined) updates.flow_id = flow_id;
    if (is_active !== undefined) updates.is_active = is_active;
    if (is_repeatable !== undefined) updates.is_repeatable = is_repeatable;

    const { data, error } = await supabase
      .from('triggers')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: 'Trigger no encontrado' });
    res.json(data);
  } catch (err) { next(err); }
});

// ── DELETE /api/triggers/:id ─────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('triggers')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
