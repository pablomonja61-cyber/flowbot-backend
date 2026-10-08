const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const plans = require('../services/plans');

router.use(auth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const allowed = ['defaultFlows', 'products', 'templates', 'variables', 'customFields', 'companies', 'selectedCompany', 'company', 'departments', 'workHours', 'labelStyles', 'translations', 'credentials', 'mcpUrl', 'invitations', 'broadcasts', 'team', 'supportAccess', 'kanban', 'connectionRoles', 'billingReceipts'];
const conflict = () => fail('La configuración cambió en otra pestaña. Recarga la página antes de guardar.', 409);
function validate(input) {
  if (!object(input) || !object(input.settingsData) || !Array.isArray(input.quickReplies) || !Array.isArray(input.labels)) fail('La configuración no tiene un formato válido.');
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 750000) fail('La configuración es demasiado grande.', 413);
  if (input.quickReplies.length > 2000 || input.labels.length > 2000) fail('Reduce la cantidad de respuestas o etiquetas.');
  if (!input.labels.every(label => typeof label === 'string' && label.length <= 100)) fail('Revisa los nombres de las etiquetas.');
  const settingsData = Object.fromEntries(allowed.filter(key => Object.hasOwn(input.settingsData, key)).map(key => [key, input.settingsData[key]]));
  for (const key of ['companies', 'departments', 'translations', 'invitations', 'broadcasts', 'team', 'credentials', 'supportAccess', 'products', 'templates', 'variables', 'customFields']) {
    if (settingsData[key] !== undefined && (!Array.isArray(settingsData[key]) || settingsData[key].length > 2000 || settingsData[key].some(row => !object(row) || typeof row.id !== 'string'))) fail('Revisa la lista de ' + key + '.');
  }
  for (const key of ['company', 'workHours', 'labelStyles', 'kanban', 'defaultFlows']) if (settingsData[key] !== undefined && !object(settingsData[key])) fail('Revisa la configuración de ' + key + '.');
  if (settingsData.kanban?.labels !== undefined && (!Array.isArray(settingsData.kanban.labels) || settingsData.kanban.labels.length > 200)) fail('Revisa las etiquetas del Kanban.');
  if (settingsData.variables) {
    const names = new Set();
    settingsData.variables = settingsData.variables.map(row => {
      const name = String(row.name || '').toLowerCase();
      if (!/^g_[a-z_][a-z0-9_]*$/.test(name) || name.length > 100) fail('Revisa el nombre de las variables globales.');
      if (names.has(name)) fail('Hay variables globales con el mismo nombre.');
      names.add(name);
      const type = row.type === 'Número' ? 'Número' : 'Texto';
      const value = type === 'Número' && row.value !== '' && row.value !== undefined ? Number(row.value) : String(row.value ?? '');
      if (type === 'Número' && value !== '' && !Number.isFinite(value)) fail('El valor de ' + name + ' debe ser un número.');
      if (typeof value === 'string' && value.length > 2000) fail('El valor de ' + name + ' es demasiado largo.');
      return { id: row.id.slice(0, 100), name, description: String(row.description || '').slice(0, 400), type, value };
    });
  }
  if (settingsData.customFields) settingsData.customFields = settingsData.customFields.map(row => {
    if (!String(row.name || '').trim()) fail('Los campos personalizados necesitan nombre.');
    return { id: row.id.slice(0, 100), name: String(row.name).trim().slice(0, 80), type: ['Texto', 'Número', 'Fecha', 'Sí / No'].includes(row.type) ? row.type : 'Texto' };
  });
  if (settingsData.connectionRoles !== undefined && !object(settingsData.connectionRoles)) fail('Revisa los roles de conexión.');
  if (settingsData.billingReceipts !== undefined && (!Array.isArray(settingsData.billingReceipts) || settingsData.billingReceipts.length > 50 || settingsData.billingReceipts.some(row => !object(row) || typeof row.id !== 'string'))) fail('Revisa los comprobantes.');
  if (settingsData.selectedCompany !== undefined && typeof settingsData.selectedCompany !== 'string') fail('Revisa la empresa seleccionada.');
  if (settingsData.credentials) settingsData.credentials = settingsData.credentials.map(row => ({ id: row.id.slice(0, 100), name: String(row.name || '').slice(0, 80), type: row.type === 'oauth' ? 'oauth' : 'static' }));
  if (settingsData.mcpUrl) { try { const url = new URL(settingsData.mcpUrl); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error(); } catch { fail('La URL de MCP no es válida.'); } }
  if (input.quickReplies.some(row => !object(row) || typeof row.name !== 'string' || typeof row.id !== 'string')) fail('Revisa las respuestas rápidas.');
  return { settingsData, quickReplies: input.quickReplies, labels: input.labels };
}
async function read(userId) {
  const { data, error } = await supabase.from('user_settings').select('data,revision').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data;
}
// Compare-and-swap in PostgreSQL: a concurrent update cannot silently replace another save.
async function save(userId, revision, data) {
  const input = { data, revision: revision + 1, updated_at: new Date().toISOString() };
  const result = revision === 0
    ? await supabase.from('user_settings').insert({ ...input, user_id: userId }).select('revision').single()
    : await supabase.from('user_settings').update(input).eq('user_id', userId).eq('revision', revision).select('revision').maybeSingle();
  if (result.error?.code === '23505' || (!result.error && !result.data)) return null;
  if (result.error) throw result.error;
  return result.data.revision;
}
router.get('/', async (req, res, next) => {
  try {
    const [row, account] = await Promise.all([read(req.user.id), supabase.from('users').select('*').eq('id', req.user.id).maybeSingle()]);
    if (account.error) throw account.error;
    const owner = account.data || req.user;
    res.json({ data: row?.data ?? null, revision: row?.revision ?? 0, account: { id: req.user.id, email: owner.email || '', name: owner.name || owner.full_name || '' } });
  } catch (error) { next(error); }
});
router.put('/', async (req, res, next) => {
  try {
    const revision = req.body?.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) fail('Vuelve a cargar la configuración.');
    const input = validate(req.body.data), current = await read(req.user.id);
    if (input.settingsData.connectionRoles !== undefined) {
      // Solo se aceptan números de API del propio usuario, y no más que los de su plan.
      const { data: cons } = await supabase.from('connections').select('id,connection_type').eq('user_id', req.user.id);
      const validos = new Set((cons || []).filter(c => (c.connection_type || 'api') !== 'qr').map(c => c.id));
      const roles = {};
      for (const [id, rol] of Object.entries(input.settingsData.connectionRoles)) if (rol === 'warmup' && validos.has(id)) roles[id] = 'warmup';
      const actuales = current?.data?.settingsData?.connectionRoles || {};
      const nuevos = Object.keys(roles).filter(id => actuales[id] !== 'warmup');
      if (nuevos.length) {
        const e = await plans.estadoCuenta(req.user.id);
        if (e.suspended) fail(plans.mensajeSuspension(e), 402);
        if (Object.keys(roles).length > e.limits.warmup) fail(e.limits.warmup <= 0 ? 'Tu plan no incluye números de calentamiento.' : `Tu plan incluye ${e.limits.warmup} número(s) de calentamiento.`, 403);
      }
      input.settingsData.connectionRoles = roles;
    }
    if ((current?.revision ?? 0) !== revision) conflict();
    const nextRevision = await save(req.user.id, revision, { ...input, organization: current?.data?.organization || [] });
    if (nextRevision === null) conflict();
    res.json({ ok: true, revision: nextRevision });
  } catch (error) { next(error); }
});
router.get('/organization', async (req, res, next) => {
  try { const row = await read(req.user.id); res.json({ data: row?.data?.organization || [] }); }
  catch (error) { next(error); }
});
router.put('/organization', async (req, res, next) => {
  try {
    const { kind, id, folder } = req.body || {};
    if (!['flow', 'trigger'].includes(kind) || typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || typeof folder !== 'string' || !folder.trim() || folder.length > 80) fail('Selecciona un registro y una carpeta válidos.');
    const { data: owned, error } = await supabase.from(kind === 'flow' ? 'flows' : 'triggers').select('id').eq('id', id).eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    if (!owned) fail('No se encontró este registro.', 404);
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await read(req.user.id), data = row?.data || { settingsData: {}, quickReplies: [], labels: [] };
      const organization = (data.organization || []).filter(item => item.kind !== kind || item.record_id !== id);
      organization.push({ kind, record_id: id, folder: folder.trim() });
      if (organization.length > 10000) fail('Se alcanzó el límite de carpetas asignadas.');
      const revision = await save(req.user.id, row?.revision || 0, { ...data, organization });
      if (revision !== null) return res.json({ ok: true, revision });
    }
    conflict();
  } catch (error) { next(error); }
});
module.exports = router;
