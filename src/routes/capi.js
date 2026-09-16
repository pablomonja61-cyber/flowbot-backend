// routes/capi.js
// Rutas de Meta CAPI Cloud — Dataset ID, conexión, listar, eliminar.
// Corregido según la documentación oficial de Meta:
// https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging/
// El Dataset ID se obtiene/crea con POST al edge /dataset del WABA
// (no es un campo del WABA como se intentó antes).

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');

router.use(auth);

// ── GET /api/capi/dataset?wabaId=... ────────────────────────────
// Obtiene (o crea, si no existía) el Dataset ID de Meta para este WABA.
router.get('/dataset', async (req, res, next) => {
  try {
    const { wabaId } = req.query;
    if (!wabaId) return res.status(400).json({ error: 'Falta wabaId.' });

    const { data: conn, error: connError } = await supabase
      .from('connections')
      .select('access_token')
      .eq('waba_id', wabaId)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (connError) throw connError;
    if (!conn?.access_token) return res.status(404).json({ error: 'No se encontró el token de esta cuenta de WhatsApp.' });

    // POST al edge /dataset — Meta crea el dataset si no existe, o
    // devuelve el que ya existía (es seguro llamarlo repetidas veces).
    const metaRes = await fetch(
      `https://graph.facebook.com/v21.0/${wabaId}/dataset?access_token=${encodeURIComponent(conn.access_token)}`,
      { method: 'POST' }
    );
    const metaData = await metaRes.json();
    if (!metaRes.ok) return res.status(502).json({ error: 'Meta rechazó la solicitud: ' + (metaData.error?.message || 'error desconocido') });

    const datasetId = metaData.id;
    if (!datasetId) return res.status(502).json({ error: 'Meta no devolvió un Dataset ID.' });

    res.json({ datasetId: String(datasetId) });
  } catch (err) { next(err); }
});

// ── POST /api/capi/connect ──────────────────────────────────────
router.post('/connect', async (req, res, next) => {
  try {
    const { wabaId, datasetId, eventToken, eventTypes } = req.body;
    if (!wabaId || !datasetId) return res.status(400).json({ error: 'Faltan datos (wabaId o datasetId).' });

    const { data: existing } = await supabase
      .from('capi_connections')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('waba_id', wabaId)
      .maybeSingle();

    const payload = {
      user_id: req.user.id,
      waba_id: wabaId,
      dataset_id: datasetId,
      event_token: eventToken || null,
      event_types: Array.isArray(eventTypes) && eventTypes.length ? eventTypes : ['Purchase'],
      updated_at: new Date().toISOString()
    };

    if (existing) {
      const { error } = await supabase.from('capi_connections').update(payload).eq('id', existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('capi_connections').insert(payload);
      if (error) throw error;
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── GET /api/capi/connections ───────────────────────────────────
router.get('/connections', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('capi_connections')
      .select('id, waba_id, dataset_id, event_types, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { next(err); }
});

// ── DELETE /api/capi/connections/:id ────────────────────────────
router.delete('/connections/:id', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('capi_connections')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
