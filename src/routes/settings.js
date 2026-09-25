const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');

router.use(auth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const allowed = ['companies', 'selectedCompany', 'company', 'departments', 'workHours', 'labelStyles', 'translations', 'credentials', 'mcpUrl', 'invitations', 'broadcasts', 'team', 'supportAccess'];
const conflict = () => fail('La configuración cambió en otra pestaña. Recarga la página antes de guardar.', 409);
function validate(input) {
  if (!object(input) || !object(input.settingsData) || !Array.isArray(input.quickReplies) || !Array.isArray(input.labels)) fail('La configuración no tiene un formato válido.');
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 750000) fail('La configuración es demasiado grande.', 413);
  if (input.quickReplies.length > 2000 || input.labels.length > 2000) fail('Reduce la cantidad de respuestas o etiquetas.');
  if (!input.labels.every(label => typeof label === 'string' && label.length <= 100)) fail('Revisa los nombres de las etiquetas.');
  const settingsData = Object.fromEntries(allowed.filter(key => Object.hasOwn(input.settingsData, key)).map(key => [key, input.settingsData[key]]));
  for (const key of ['companies', 'departments', 'translations', 'invitations', 'broadcasts', 'team', 'credentials', 'supportAccess']) {
    if (settingsData[key] !== undefined && (!Array.isArray(settingsData[key]) || settingsData[key].length > 2000 || settingsData[key].some(row => !object(row) || typeof row.id !== 'string'))) fail('Revisa la lista de ' + key + '.');
  }
  for (const key of ['company', 'workHours', 'labelStyles']) if (settingsData[key] !== undefined && !object(settingsData[key])) fail('Revisa la configuración de ' + key + '.');
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
