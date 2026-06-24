const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { startQRSession, getQRCode, closeQRSession } = require('../services/baileys');
const { v4: uuidv4 } = require('uuid');

router.use(auth);

// ── POST /api/qr-connections — crear conexión QR nueva ───────
router.post('/', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'El nombre es requerido' });

    // Crear registro de conexión QR en Supabase
    const { data: connection, error } = await supabase
      .from('connections')
      .insert({
        id: uuidv4(),
        user_id: req.user.id,
        name,
        connection_type: 'qr',
        qr_status: 'pending',
        is_active: false,
        phone_number_id: `qr_${uuidv4()}`, // placeholder
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    // Iniciar sesión QR en background
    startQRSession(connection.id, req.user.id).catch(err => {
      console.error('[QR] Error iniciando sesión:', err.message);
    });

    res.json({ success: true, connection_id: connection.id });
  } catch (err) { next(err); }
});

// ── GET /api/qr-connections/:id/qr — obtener QR actual ──────
router.get('/:id/qr', async (req, res, next) => {
  try {
    const { id } = req.params;

    // Verificar que la conexión pertenece al usuario
    const { data: connection } = await supabase
      .from('connections')
      .select('id, user_id, qr_code, qr_status, phone_number, name')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();

    if (!connection) return res.status(404).json({ error: 'Conexión no encontrada' });

    res.json({
      qr_code: connection.qr_code,
      status: connection.qr_status,
      phone_number: connection.phone_number,
      name: connection.name
    });
  } catch (err) { next(err); }
});

// ── POST /api/qr-connections/:id/reconnect — reconectar ─────
router.post('/:id/reconnect', async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: connection } = await supabase
      .from('connections')
      .select('id, user_id')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();

    if (!connection) return res.status(404).json({ error: 'Conexión no encontrada' });

    startQRSession(id, req.user.id).catch(err => {
      console.error('[QR] Error reconectando:', err.message);
    });

    res.json({ success: true, message: 'Reconectando...' });
  } catch (err) { next(err); }
});

// ── DELETE /api/qr-connections/:id — desconectar y eliminar ──
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: connection } = await supabase
      .from('connections')
      .select('id, user_id')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();

    if (!connection) return res.status(404).json({ error: 'Conexión no encontrada' });

    await closeQRSession(id);

    const { error } = await supabase
      .from('connections')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
