const express = require('express');
const axios = require('axios');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { GRAPH_VERSION } = require('../services/capiBusiness');

router.use(auth);

// El token nunca vuelve al navegador: solo se informa si existe.
const publico = p => ({
  id: p.id, type: p.type, datasetId: p.dataset_id, pageId: p.page_id, connectionIds: p.connection_ids || [],
  hasToken: !!p.access_token, lastStatus: p.last_status, lastEventAt: p.last_event_at, createdAt: p.created_at
});

async function validar(req, { datasetId, pageId, connectionIds }, idActual = null) {
  if (!/^\d{5,25}$/.test(String(datasetId || ''))) return 'El ID del Dataset debe ser numérico.';
  if (!/^\d{5,25}$/.test(String(pageId || ''))) return 'El Page ID debe ser numérico.';
  if (!Array.isArray(connectionIds) || !connectionIds.length) return 'Selecciona al menos una conexión.';
  const { data: cons } = await supabase.from('connections').select('id, connection_type').eq('user_id', req.user.id).in('id', connectionIds);
  if ((cons || []).length !== connectionIds.length) return 'Alguna conexión no existe.';
  if ((cons || []).some(c => c.connection_type !== 'qr')) return 'Meta CAPI Business es para conexiones QR. Las de API oficial usan Meta CAPI Cloud.';
  const { data: otros } = await supabase.from('capi_business_projects').select('id, connection_ids').eq('user_id', req.user.id);
  const ocupadas = new Set((otros || []).filter(p => p.id !== idActual).flatMap(p => p.connection_ids || []));
  if (connectionIds.some(id => ocupadas.has(id))) return 'Alguna conexión ya pertenece a otro proyecto.';
  return null;
}

async function comprobarMeta(datasetId, token) {
  try {
    await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${datasetId}`, { params: { fields: 'id,name', access_token: token }, timeout: 10000 });
    return null;
  } catch (e) {
    return 'Meta rechazó el Dataset o el token: ' + (e.response?.data?.error?.message || e.message);
  }
}

router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('capi_business_projects').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    if (error) throw error;
    res.json((data || []).map(publico));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { type = 'purchase_ads', datasetId, accessToken, pageId, connectionIds } = req.body || {};
    if (!accessToken || String(accessToken).length < 20) return res.status(400).json({ error: 'Falta el token de acceso de Conversion API.' });
    const fallo = await validar(req, { datasetId, pageId, connectionIds });
    if (fallo) return res.status(400).json({ error: fallo });
    const meta = await comprobarMeta(datasetId, accessToken);
    if (meta) return res.status(400).json({ error: meta });
    const { data, error } = await supabase.from('capi_business_projects').insert({
      user_id: req.user.id, type, dataset_id: String(datasetId), access_token: String(accessToken).trim(), page_id: String(pageId), connection_ids: connectionIds
    }).select().single();
    if (error) throw error;
    res.status(201).json(publico(data));
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { datasetId, accessToken, pageId, connectionIds } = req.body || {};
    const { data: actual } = await supabase.from('capi_business_projects').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!actual) return res.status(404).json({ error: 'Proyecto no encontrado.' });
    const nuevo = { datasetId: datasetId ?? actual.dataset_id, pageId: pageId ?? actual.page_id, connectionIds: connectionIds ?? actual.connection_ids };
    const fallo = await validar(req, nuevo, actual.id);
    if (fallo) return res.status(400).json({ error: fallo });
    const token = accessToken ? String(accessToken).trim() : actual.access_token;
    if (accessToken || String(nuevo.datasetId) !== actual.dataset_id) {
      const meta = await comprobarMeta(nuevo.datasetId, token);
      if (meta) return res.status(400).json({ error: meta });
    }
    const { data, error } = await supabase.from('capi_business_projects').update({
      dataset_id: String(nuevo.datasetId), page_id: String(nuevo.pageId), connection_ids: nuevo.connectionIds, access_token: token, updated_at: new Date().toISOString()
    }).eq('id', actual.id).select().single();
    if (error) throw error;
    res.json(publico(data));
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await supabase.from('capi_business_projects').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { next(e); }
});

module.exports = router;
