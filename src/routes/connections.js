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
// Body: { name, phone_number_id, waba_id, access_token }
router.post('/', async (req, res, next) => {
  try {
    const { name, phone_number_id, waba_id, access_token } = req.body;
    if (!name || !phone_number_id || !waba_id || !access_token) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    // Verificar que el token es válido con Meta
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
        access_token, // se guarda encriptado idealmente
        is_active: true
      })
      .select('id, name, phone_number, waba_id, is_active, created_at')
      .single();
    if (error) throw error;
    res.status(201).json(data);
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
