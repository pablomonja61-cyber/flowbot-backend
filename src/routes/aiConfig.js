const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');

router.use(auth);

// ── GET /api/ai-config ─────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('ai_config')
      .select('*')
      .eq('user_id', req.user.id)
      .single();

    if (error || !data) {
      return res.json({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        response_time: 10,
        is_active: true,
        system_prompt: ''
      });
    }

    res.json(data);
  } catch (err) { next(err); }
});

// ── PUT /api/ai-config ─────────────────────────────────────
router.put('/', async (req, res, next) => {
  try {
    const { model, response_time, is_active, system_prompt } = req.body;

    const { data: existing } = await supabase
      .from('ai_config')
      .select('id')
      .eq('user_id', req.user.id)
      .single();

    if (existing) {
      const updateData = { updated_at: new Date().toISOString() };
      if (model !== undefined) updateData.model = model;
      if (response_time !== undefined) updateData.response_time = response_time;
      if (is_active !== undefined) updateData.is_active = is_active;
      if (system_prompt !== undefined) updateData.system_prompt = system_prompt;

      const { data, error } = await supabase
        .from('ai_config')
        .update(updateData)
        .eq('user_id', req.user.id)
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
          model: model || 'meta-llama/llama-4-scout-17b-16e-instruct',
          response_time: response_time || 10,
          is_active: is_active !== undefined ? is_active : true,
          system_prompt: system_prompt || ''
        })
        .select()
        .single();

      if (error) throw error;
      return res.json({ success: true, data });
    }
  } catch (err) { next(err); }
});

module.exports = router;
