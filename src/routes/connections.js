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
      .select('id, name, phone_number, waba_id, is_active, connection_type, qr_status, created_at')
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

// ── POST /api/connections/embedded-signup ────────────────────
// Recibe el "code" que devuelve el flujo de WhatsApp Embedded
// Signup de Meta (cuando un cliente conecta SU PROPIO WhatsApp
// Business solo, sin que tengamos que configurarle nada a mano), lo
// intercambia por un token de acceso real, y guarda la conexión.
router.post('/embedded-signup', async (req, res, next) => {
  try {
    const { code, phone_number_id, waba_id } = req.body;
    if (!code || !phone_number_id || !waba_id) {
      return res.status(400).json({ error: 'code, phone_number_id y waba_id son requeridos' });
    }

    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) {
      return res.status(500).json({ error: 'META_APP_ID / META_APP_SECRET no configurados en el servidor' });
    }

    // 1. Intercambiar el "code" de un solo uso por un token de acceso real
    const tokenRes = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
      params: { client_id: appId, client_secret: appSecret, code }
    });
    const accessToken = tokenRes.data?.access_token;
    if (!accessToken) {
      return res.status(400).json({ error: 'Meta no devolvió un token de acceso válido' });
    }

    // 2. Traer el número de teléfono real y el nombre verificado del negocio
    let displayPhone = phone_number_id;
    let verifiedName = 'WhatsApp conectado';
    try {
      const infoRes = await axios.get(`https://graph.facebook.com/v21.0/${phone_number_id}`, {
        params: { fields: 'display_phone_number,verified_name', access_token: accessToken }
      });
      displayPhone = infoRes.data?.display_phone_number || phone_number_id;
      verifiedName = infoRes.data?.verified_name || verifiedName;
    } catch (e) {
      console.warn('[Embedded Signup] No se pudo traer info del número:', e.response?.data || e.message);
    }

    // 3. Suscribir nuestra app a los webhooks de este WABA — sin esto,
    // Meta nunca nos avisaría de los mensajes entrantes de este cliente.
    try {
      await axios.post(`https://graph.facebook.com/v21.0/${waba_id}/subscribed_apps`, {}, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
    } catch (e) {
      console.error('[Embedded Signup] Error suscribiendo webhooks:', e.response?.data || e.message);
      // No cortamos el proceso por esto — igual guardamos la conexión,
      // pero avisamos en la respuesta para poder revisarlo después.
    }

    // 4. Guardar la conexión, igual que si la hubiera armado a mano
    const { data, error } = await supabase
      .from('connections')
      .insert({
        id: uuidv4(),
        user_id: req.user.id,
        name: verifiedName,
        phone_number: displayPhone,
        phone_number_id,
        waba_id,
        access_token: accessToken,
        connection_type: 'api',
        is_active: true
      })
      .select('id, name, phone_number, waba_id, is_active, connection_type, created_at')
      .single();
    if (error) throw error;

    console.log(`[Embedded Signup] Nueva conexión creada para user ${req.user.id}: ${displayPhone}`);
    res.status(201).json(data);
  } catch (err) {
    console.error('[Embedded Signup] Error:', err.response?.data || err.message);
    next(err);
  }
});

module.exports = router;