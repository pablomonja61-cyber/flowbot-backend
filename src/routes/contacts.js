const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');

router.use(auth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const columns = 'id,name,phone,email,status,origin,tags,address,custom_fields,created_at,updated_at';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, max, field, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.trim().length > max) fail('Revisa el campo ' + field + '.');
  return value.trim();
}
function validate(input) {
  if (!object(input)) fail('Revisa los datos del contacto.');
  const name = text(input.name, 100, 'nombre');
  const phone = text(input.phone, 30, 'teléfono').replace(/[\s().-]/g, '');
  const email = text(input.email, 180, 'correo');
  if (!name) fail('Escribe el nombre completo.');
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) fail('Escribe el teléfono con código de país.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Revisa el correo del contacto.');
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 20) fail('Incluye un máximo de 20 etiquetas.');
  const address = input.address ?? {};
  if (!object(address)) fail('Revisa la dirección.');
  const fields = input.customFields ?? input.custom_fields ?? [];
  if (!Array.isArray(fields) || fields.length > 20 || fields.some(row => !object(row))) fail('Revisa los campos personalizados.');
  const status = input.status ?? 'Activo';
  if (!['Activo', 'Lead', 'Inactivo'].includes(status)) fail('Selecciona un estado válido.');
  return {
    name, phone, email, status, origin: text(input.origin, 80, 'origen') || 'Manual',
    tags: [...new Set(tags.map(tag => text(tag, 40, 'etiqueta')).filter(Boolean))],
    address: Object.fromEntries(['street', 'city', 'region', 'postalCode', 'country'].map(key => [key, text(address[key], 180, key)])),
    custom_fields: fields.map(row => ({ name: text(row.name, 80, 'nombre del campo'), value: text(row.value, 500, 'valor del campo') })).filter(row => row.name)
  };
}
function record(row) {
  return { ...row, tags: row.tags || [], address: row.address || {}, customFields: row.custom_fields || [], created: row.created_at, updated: row.updated_at };
}
function check(error) {
  if (!error) return;
  if (error.code === '23505') fail('Ya existe un contacto con este teléfono.', 409);
  throw error;
}
function identifier(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail('El contacto no es válido.');
  return value;
}
router.get('/', async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1), limit = Number(req.query.limit ?? 500);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 500) fail('Paginación no válida.');
    const { data, count, error } = await supabase.from('contacts').select(columns, { count: 'exact' }).eq('user_id', req.user.id).order('name').order('id').range((page - 1) * limit, page * limit - 1);
    check(error);
    res.json({ data: data.map(record), total: count, page, limit, hasMore: page * limit < count });
  } catch (error) { next(error); }
});
router.post('/import', async (req, res, next) => {
  try {
    const contacts = req.body?.contacts;
    if (!Array.isArray(contacts) || !contacts.length || contacts.length > 50) fail('Importa entre 1 y 50 contactos por lote.');
    const unique = new Map();
    for (const input of contacts) { const row = validate(input); if (!unique.has(row.phone)) unique.set(row.phone, { ...row, user_id: req.user.id }); }
    const { data, error } = await supabase.from('contacts').upsert([...unique.values()], { onConflict: 'user_id,phone', ignoreDuplicates: true }).select('id');
    check(error);
    res.json({ imported: data.length, duplicates: contacts.length - data.length });
  } catch (error) { next(error); }
});
router.post('/', async (req, res, next) => {
  try {
    const input = validate(req.body);
    const { data, error } = await supabase.from('contacts').insert({ ...input, user_id: req.user.id }).select(columns).single();
    check(error); res.status(201).json({ data: record(data) });
  } catch (error) { next(error); }
});
router.put('/:id', async (req, res, next) => {
  try {
    const input = validate(req.body), id = identifier(req.params.id);
    const { data, error } = await supabase.from('contacts').update({ ...input, updated_at: new Date().toISOString() }).eq('user_id', req.user.id).eq('id', id).select(columns).maybeSingle();
    check(error); if (!data) fail('No se encontró este contacto.', 404);
    res.json({ data: record(data) });
  } catch (error) { next(error); }
});
router.delete('/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('contacts').delete().eq('user_id', req.user.id).eq('id', identifier(req.params.id)).select('id').maybeSingle();
    check(error); if (!data) fail('No se encontró este contacto.', 404);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
module.exports = router;
