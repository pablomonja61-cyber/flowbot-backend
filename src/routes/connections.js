const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

router.use(auth);

// ── GET /api/connections ──────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('connections')
      .select('id, name, phone_number, waba_id, is_active, created_at')
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// ── POST /api/connections ─────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { name, phone_number_id, waba_id, access_token } = req.body;
    if (!name || !phone_number_id || !waba_id || !access_token) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }
    try {
      const verify = await axios.get(
        `https://graph.facebook.com/v19.0/${phone_number_id}`,
        { headers: { Authorization: `Bearer ${access_token}` } }
      );
      var phone_number = verify.data.display_phone_number || phone_number_id;
    } catch (e) {
      return res.status(400).json({ error: 'Token de Meta inválido o phone_number_id incorrecto' });
    }
    const { data, error } = await supabase
      .from('connections')
      .insert({
        id: uuidv4(),
        user_id: req.user.id,
        name,
        phone_number,
        phone_number_id,
        waba_id,
        access_token,
        is_active: true
      })
      .select('id, name, phone_number, waba_id, is_active, created_at')
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// ── PUT /api/connections/:id ──────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const { name, phone_number_id, waba_id, access_token } = req.body;

    // Verificar que la conexión pertenece al usuario
    const { data: existing } = await supabase
      .from('connections')
      .select('id')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (!existing) return res.status(404).json({ error: 'Conexión no encontrada' });

    // Construir objeto de actualización
    const updates = {};
    if (name) updates.name = name;
    if (waba_id) updates.waba_id = waba_id;
    if (access_token) updates.access_token = access_token;

    // Si cambia el phone_number_id verificar con Meta
    if (phone_number_id) {
      updates.phone_number_id = phone_number_id;
      try {
        const verify = await axios.get(
          `https://graph.facebook.com/v19.0/${phone_number_id}`,
          { headers: { Authorization: `Bearer ${access_token || req.body.access_token}` } }
        );
        updates.phone_number = verify.data.display_phone_number || phone_number_id;
      } catch (e) {
        // Si falla la verificación igual guardamos
        updates.phone_number = phone_number_id;
      }
    }

    const { data, error } = await supabase
      .from('connections')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select('id, name, phone_number, waba_id, is_active, created_at')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// ── DELETE /api/connections/:id ───────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('connections')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;