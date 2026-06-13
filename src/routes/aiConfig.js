const express = require('express');
const router = express.Router();
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');

// Middleware para obtener user_id del token JWT
function getUserId(req) {
  return req.user?.id || req.userId;
}

// GET /api/ai-config — obtener config actual
router.get('/', async (req, res) => {
  try {
    const userId = getUserId(req);
    const { data, error } = await supabase
      .from('ai_config')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      // Devolver config por defecto si no existe
      return res.json({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        response_time: 10,
        is_active: true,
        system_prompt: ''
      });
    }

    res.json(data);
  } catch (err) {
    console.error('[AI Config GET error]', err.message);
    res.status(500).json({ error: 'Error obteniendo configuración' });
  }
});

// PUT /api/ai-config — guardar/actualizar config
router.put('/', async (req, res) => {
  try {
    const userId = getUserId(req);
    const { model, response_time, is_active, system_prompt } = req.body;

    // Verificar si ya existe config para este usuario
    const { data: existing } = await supabase
      .from('ai_config')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (existing) {
      // Actualizar
      const updateData = {};
      if (model !== undefined) updateData.model = model;
      if (response_time !== undefined) updateData.response_time = response_time;
      if (is_active !== undefined) updateData.is_active = is_active;
      if (system_prompt !== undefined) updateData.system_prompt = system_prompt;
      updateData.updated_at = new Date().toISOString();

      const { data, error } = await supabase
        .from('ai_config')
        .update(updateData)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) throw error;
      return res.json({ success: true, data });
    } else {
      // Crear nuevo
      const { data, error } = await supabase
        .from('ai_config')
        .insert({
          id: uuidv4(),
          user_id: userId,
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
  } catch (err) {
    console.error('[AI Config PUT error]', err.message);
    res.status(500).json({ error: 'Error guardando configuración' });
  }
});

module.exports = router;
