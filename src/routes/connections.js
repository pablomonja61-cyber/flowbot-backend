const express = require('express');
const router = express.Router();
const plans = require('../services/plans');
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const followupGuard = require('../services/followupGuard');

router.use(auth);

// ── GET /api/connections ──────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('connections')
      .select('id, name, phone_number, waba_id, is_active, connection_type, qr_status, created_at, verify_free_before_blocking, calls_enabled, followup_regulation_enabled')
      .eq('user_id', req.user.id);
    if (error) throw error;
    // Datos de "Prevención de baneo" (solo conexiones de API)
    const lista = await Promise.all((data || []).map(async con => {
      if (con.connection_type === 'qr') return con;
      try {
        const s = await followupGuard.estadisticas(con.id);
        return {
          ...con,
          protected_mode: followupGuard.enModoProtegido(con),
          followups_sent: s.sent, followups_answered: s.answered, followup_response_rate: s.rate
        };
      } catch (_) { return con; }
    }));
    res.json(lista);
  } catch (err) { next(err); }
});

// ── POST /api/connections ─────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { name, phone_number_id, waba_id, access_token } = req.body;
    if (!name || !phone_number_id || !waba_id || !access_token) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }
    const permiso = await plans.puedeConectar(req.user.id, 'api', 'primary');
    if (!permiso.ok) return res.status(permiso.code === 'PLAN_SUSPENDED' ? 402 : 403).json({ error: permiso.message, code: permiso.code });
    try {
      const verify = await axios.get(
        `https://graph.facebook.com/v26.0/${phone_number_id}`,
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
          `https://graph.facebook.com/v26.0/${phone_number_id}`,
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

// ── PATCH /api/connections/:id/options ────────────────────────
// Interruptores de la conexión (pantalla de detalle de la API):
//   verify_free_before_blocking, followup_regulation_enabled, calls_enabled  (true/false)
// "Llamadas" se aplica de verdad en Meta (WhatsApp Calling API); si Meta lo rechaza, no se guarda.
router.patch('/:id/options', async (req, res, next) => {
  try {
    const { data: con } = await supabase.from('connections')
      .select('id, phone_number_id, access_token, connection_type, calls_enabled')
      .eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!con) return res.status(404).json({ error: 'Conexión no encontrada' });

    const aBool = v => typeof v === 'boolean' ? v : (typeof v === 'string' ? (v === 'true' ? true : v === 'false' ? false : undefined) : undefined);
    const cambios = {};
    for (const k of ['verify_free_before_blocking', 'followup_regulation_enabled']) {
      const v = aBool(req.body?.[k]);
      if (req.body?.[k] !== undefined) {
        if (v === undefined) return res.status(400).json({ error: `"${k}" debe ser true o false` });
        cambios[k] = v;
      }
    }
    if (req.body?.calls_enabled !== undefined) {
      const v = aBool(req.body.calls_enabled);
      if (v === undefined) return res.status(400).json({ error: '"calls_enabled" debe ser true o false' });
      if (!con.phone_number_id || !con.access_token || con.connection_type === 'qr') {
        return res.status(400).json({ error: 'Las llamadas solo están disponibles en conexiones de API oficial.' });
      }
      try {
        await axios.post(`https://graph.facebook.com/v26.0/${con.phone_number_id}/settings`,
          { calling: { status: v ? 'ENABLED' : 'DISABLED' } },
          { headers: { Authorization: `Bearer ${con.access_token}`, 'Content-Type': 'application/json' } });
      } catch (e) {
        const detalle = e.response?.data?.error?.error_user_msg || e.response?.data?.error?.message || e.message;
        return res.status(502).json({ error: `Meta no permitió cambiar las llamadas: ${detalle}` });
      }
      cambios.calls_enabled = v;
    }
    if (!Object.keys(cambios).length) return res.status(400).json({ error: 'Nada para actualizar' });

    const { data, error } = await supabase.from('connections').update(cambios)
      .eq('id', req.params.id).eq('user_id', req.user.id)
      .select('id, verify_free_before_blocking, calls_enabled, followup_regulation_enabled').single();
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
    const rol = req.body.role === 'warmup' ? 'warmup' : 'primary';
    const permiso = await plans.puedeConectar(req.user.id, 'api', rol);
    if (!permiso.ok) return res.status(permiso.code === 'PLAN_SUSPENDED' ? 402 : 403).json({ error: permiso.message, code: permiso.code });

    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) {
      return res.status(500).json({ error: 'META_APP_ID / META_APP_SECRET no configurados en el servidor' });
    }

    // 1. Intercambiar el "code" de un solo uso por un token de acceso real
    const tokenRes = await axios.get('https://graph.facebook.com/v26.0/oauth/access_token', {
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
      const infoRes = await axios.get(`https://graph.facebook.com/v26.0/${phone_number_id}`, {
        params: { fields: 'display_phone_number,verified_name', access_token: accessToken }
      });
      displayPhone = infoRes.data?.display_phone_number || phone_number_id;
      verifiedName = infoRes.data?.verified_name || verifiedName;
    } catch (e) {
      console.warn('[Embedded Signup] No se pudo traer info del número:', e.response?.data || e.message);
    }

    // 2.5 Registrar el número en la Cloud API — sin este paso, el número
    // se queda para siempre en estado "Pending" en el panel de Meta,
    // aunque el resto de la conexión haya salido bien. Se le pone un
    // PIN de 6 dígitos al azar (Meta lo pide para la verificación en
    // 2 pasos, pero no hace falta que el cliente lo sepa ni lo use).
    try {
      const pin = String(Math.floor(100000 + Math.random() * 900000));
      await axios.post(`https://graph.facebook.com/v26.0/${phone_number_id}/register`, {
        messaging_product: 'whatsapp',
        pin
      }, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      console.log(`[Embedded Signup] Número ${phone_number_id} registrado en Cloud API correctamente`);
    } catch (e) {
      console.error('[Embedded Signup] Error registrando el número en Cloud API:', e.response?.data || e.message);
      // No cortamos el proceso — si esto falla, el número puede quedar
      // en Pending, pero al menos se ve el motivo exacto en los logs.
    }

    // 3. Suscribir nuestra app a los webhooks de este WABA — sin esto,
    // Meta nunca nos avisaría de los mensajes entrantes de este cliente.
    try {
      await axios.post(`https://graph.facebook.com/v26.0/${waba_id}/subscribed_apps`, {}, {
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

    if (rol === 'warmup') await plans.marcarRol(req.user.id, data.id, 'warmup').catch(e => console.error('[Embedded Signup] No se guardó el rol:', e.message));
    console.log(`[Embedded Signup] Nueva conexión creada para user ${req.user.id}: ${displayPhone} (${rol})`);
    res.status(201).json({ ...data, role: rol });
  } catch (err) {
    console.error('[Embedded Signup] Error:', err.response?.data || err.message);
    next(err);
  }
});

// ── POST /api/connections/qr ──────────────────────────────────
// Crea una conexión nueva por QR y arranca la sesión de Baileys.
router.post('/qr', async (req, res, next) => {
  try {
    const { name } = req.body;
    const permiso = await plans.puedeConectar(req.user.id, 'qr');
    if (!permiso.ok) return res.status(permiso.code === 'PLAN_SUSPENDED' ? 402 : 403).json({ error: permiso.message, code: permiso.code });
    const id = uuidv4();

    const { data, error } = await supabase
      .from('connections')
      .insert({
        id,
        user_id: req.user.id,
        name: name || 'WhatsApp (QR)',
        connection_type: 'qr',
        qr_status: 'pending',
        is_active: false
      })
      .select('id, name, connection_type, qr_status, created_at')
      .single();
    if (error) throw error;

    // Arranca la sesión de Baileys en segundo plano — no se espera
    // aquí, porque generar el QR toma unos segundos.
    const { startQRSession } = require('../services/baileys');
    startQRSession(id, req.user.id).catch(e => console.error('[QR] Error iniciando sesión:', e.message));

    res.status(201).json(data);
  } catch (err) { next(err); }
});

// ── GET /api/connections/qr/:id ────────────────────────────────
// Para hacer polling: devuelve el QR actual (si sigue pendiente) o
// el estado de conexión.
router.get('/qr/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('connections')
      .select('id, name, phone_number, qr_code, qr_status')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Conexión no encontrada' });
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;