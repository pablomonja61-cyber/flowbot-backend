const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');

router.use(auth);

// ── GET /api/ai-config — listar todas las configs ──────────
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('ai_config')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Si no hay configs, devolver array vacío
    res.json(data || []);
  } catch (err) { next(err); }
});

// ── POST /api/ai-config — crear nueva config ───────────────
router.post('/', async (req, res, next) => {
  try {
    const { name, model, response_time, is_active, system_prompt } = req.body;

    // Si se activa esta, desactivar las demás
    if (is_active) {
      await supabase
        .from('ai_config')
        .update({ is_active: false })
        .eq('user_id', req.user.id);
    }

    const { data, error } = await supabase
      .from('ai_config')
      .insert({
        id: uuidv4(),
        user_id: req.user.id,
        name: name || 'Configuración IA',
        model: model || 'meta-llama/llama-4-scout-17b-16e-instruct',
        response_time: response_time || 10,
        is_active: is_active !== undefined ? is_active : true,
        system_prompt: system_prompt || '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ── PUT /api/ai-config/:id — actualizar config ─────────────
router.put('/:id', async (req, res, next) => {
  try {
    const { name, model, response_time, is_active, system_prompt } = req.body;

    // Si se activa esta, desactivar las demás
    if (is_active) {
      await supabase
        .from('ai_config')
        .update({ is_active: false })
        .eq('user_id', req.user.id);
    }

    const updateData = { updated_at: new Date().toISOString() };
    if (name !== undefined) updateData.name = name;
    if (model !== undefined) updateData.model = model;
    if (response_time !== undefined) updateData.response_time = response_time;
    if (is_active !== undefined) updateData.is_active = is_active;
    if (system_prompt !== undefined) updateData.system_prompt = system_prompt;

    const { data, error } = await supabase
      .from('ai_config')
      .update(updateData)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ── DELETE /api/ai-config/:id — eliminar config ────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('ai_config')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});


// ── PATCH /api/ai-config/:id — toggle activo ──────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const { is_active, name, model, response_time, system_prompt } = req.body;

    if (is_active) {
      await supabase
        .from('ai_config')
        .update({ is_active: false })
        .eq('user_id', req.user.id);
    }

    const updateData = { updated_at: new Date().toISOString() };
    if (name !== undefined) updateData.name = name;
    if (model !== undefined) updateData.model = model;
    if (response_time !== undefined) updateData.response_time = response_time;
    if (is_active !== undefined) updateData.is_active = is_active;
    if (system_prompt !== undefined) updateData.system_prompt = system_prompt;

    const { data, error } = await supabase
      .from('ai_config')
      .update(updateData)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ── PUT /api/ai-config (legacy) — compatibilidad ──────────
router.put('/', async (req, res, next) => {
  try {
    const { model, response_time, is_active, system_prompt } = req.body;

    const { data: existing } = await supabase
      .from('ai_config')
      .select('id')
      .eq('user_id', req.user.id)
      .limit(1)
      .single();

    if (existing) {
      const { data, error } = await supabase
        .from('ai_config')
        .update({
          model, response_time, is_active, system_prompt,
          updated_at: new Date().toISOString()
        })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      return res.json({ success: true, data });
    } else {
      const { data, error } = await supabase
        .from('ai_config')
        .insert({
          id: uuidv4(),
          user_id: req.user.id,
          name: 'Configuración IA',
          model: model || 'meta-llama/llama-4-scout-17b-16e-instruct',
          response_time: response_time || 10,
          is_active: is_active !== undefined ? is_active : true,
          system_prompt: system_prompt || '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();
      if (error) throw error;
      return res.json({ success: true, data });
    }
  } catch (err) { next(err); }
});

module.exports = router;