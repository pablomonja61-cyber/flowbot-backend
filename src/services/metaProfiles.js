// services/metaProfiles.js
// Manejo de los perfiles de Meta que cada usuario conecta pegando un
// token (System User Token de su Business Manager). Un usuario puede
// tener VARIOS perfiles; cada perfil ve sus propias cuentas publicitarias.
//
// Los tokens se guardan CIFRADOS (AES-256-GCM). La llave se deriva de
// META_TOKEN_KEY si existe, o de JWT_SECRET (que ya tienes) si no.

const crypto = require('crypto');
const axios = require('axios');
const supabase = require('../models/supabase');

const GRAPH_VERSION = 'v26.0'; // misma versión que ya usa meta.js
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

function key() {
  const base = process.env.META_TOKEN_KEY || process.env.JWT_SECRET;
  if (!base) throw new Error('Falta JWT_SECRET (o META_TOKEN_KEY) para cifrar los tokens de Meta.');
  return crypto.createHash('sha256').update('meta-profiles:' + base).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}

function decrypt(payload) {
  const [iv, tag, enc] = payload.split(':').map(h => Buffer.from(h, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// Convierte los errores de Meta en mensajes que el usuario entiende.
function metaError(err) {
  if (err.metaMessage) return { code: err.metaCode ?? null, message: err.metaMessage };
  const e = err.response?.data?.error;
  if (!e) return { code: null, message: err.message };
  if (e.code === 190) return { code: 190, message: 'El token venció, fue revocado o no es válido. Genera uno nuevo en Meta y vuelve a pegarlo.' };
  if (e.code === 10 || e.code === 200 || e.code === 294) return { code: e.code, message: 'El token no tiene permiso para leer publicidad. Al generarlo marca el permiso "ads_read" y asigna las cuentas publicitarias al usuario del sistema.' };
  if (e.code === 4 || e.code === 17 || e.code === 32 || e.code === 613) return { code: e.code, message: 'Meta pidió esperar un momento (límite de velocidad). Intenta de nuevo en unos minutos.' };
  return { code: e.code || null, message: e.message || 'Error desconocido de Meta.' };
}

// Pide a Meta el nombre del perfil y sus cuentas publicitarias.
async function fetchProfileFromMeta(token) {
  const me = await axios.get(`${GRAPH}/me`, { params: { fields: 'id,name', access_token: token }, timeout: 15000 });
  const accounts = [];
  let url = `${GRAPH}/me/adaccounts`;
  let params = { fields: 'id,account_id,name,currency,account_status', limit: 100, access_token: token };
  for (let page = 0; page < 10 && url; page++) {
    const r = await axios.get(url, { params, timeout: 20000 });
    accounts.push(...(r.data?.data || []));
    url = r.data?.paging?.next || null;
    params = undefined; // el "next" ya trae todos los parámetros
  }
  return { fb_id: String(me.data.id), name: me.data.name || 'Perfil de Meta', accounts };
}

async function saveAccounts(profileId, userId, accounts) {
  await supabase.from('meta_profile_accounts').delete().eq('profile_id', profileId);
  if (!accounts.length) return;
  const rows = accounts.map(a => ({
    profile_id: profileId, user_id: userId,
    account_id: String(a.id).replace(/^act_/, ''),
    name: a.name || null, currency: a.currency || null,
    account_status: a.account_status ?? null,
    updated_at: new Date().toISOString()
  }));
  const { error } = await supabase.from('meta_profile_accounts').insert(rows);
  if (error) throw error;
}

// Perfiles activos del usuario, con su token ya descifrado (uso interno).
async function getProfilesWithTokens(userId) {
  const { data, error } = await supabase
    .from('meta_profiles').select('id, name, token_encrypted, status')
    .eq('user_id', userId).eq('status', 'active');
  if (error) throw error;
  return (data || []).map(p => ({ id: p.id, name: p.name, token: decrypt(p.token_encrypted) }));
}

// Token que corresponde a una cuenta publicitaria concreta.
async function tokenForAccount(userId, accountId) {
  const id = String(accountId || '').replace(/^act_/, '');
  const { data } = await supabase
    .from('meta_profile_accounts').select('profile_id')
    .eq('user_id', userId).eq('account_id', id).limit(1).maybeSingle();
  if (!data) return null;
  const { data: p } = await supabase
    .from('meta_profiles').select('id, name, token_encrypted, status')
    .eq('id', data.profile_id).eq('status', 'active').maybeSingle();
  return p ? { profileId: p.id, name: p.name, token: decrypt(p.token_encrypted) } : null;
}

// Marca un perfil como vencido cuando Meta responde error 190.
async function markExpired(profileId, message) {
  await supabase.from('meta_profiles')
    .update({ status: 'expired', last_error: message, last_checked_at: new Date().toISOString() })
    .eq('id', profileId);
}

// Todas las cuentas publicitarias de todos los perfiles del usuario.
async function listAllAccounts(userId) {
  const { data, error } = await supabase
    .from('meta_profile_accounts')
    .select('account_id, name, currency, account_status, profile_id, meta_profiles!inner(name, status)')
    .eq('user_id', userId);
  if (error) throw error;
  return (data || []).map(a => ({
    id: 'act_' + a.account_id,
    account_id: a.account_id,
    name: a.name,
    currency: a.currency,
    account_status: a.account_status,
    profile_id: a.profile_id,
    profile_name: a.meta_profiles?.name,
    profile_status: a.meta_profiles?.status
  }));
}

// ── Token "viejo" del OAuth (ads_config), por si alguien ya lo tenía ──
async function legacyToken(userId) {
  const { data } = await supabase.from('ads_config').select('access_token').eq('user_id', userId).maybeSingle();
  return data?.access_token || null;
}

// Tokens que se pueden probar para un usuario, en orden: primero el del
// perfil dueño de esa cuenta, luego los demás perfiles, al final el viejo.
async function candidateTokens(userId, accountId) {
  const out = [];
  if (accountId) {
    const t = await tokenForAccount(userId, accountId);
    if (t) out.push({ profileId: t.profileId, name: t.name, token: t.token });
  }
  for (const p of await getProfilesWithTokens(userId)) {
    if (!out.some(o => o.profileId === p.id)) out.push({ profileId: p.id, name: p.name, token: p.token });
  }
  const legacy = await legacyToken(userId);
  if (legacy && !out.some(o => o.token === legacy)) out.push({ profileId: null, name: 'Conexión anterior', token: legacy });
  return out;
}

// Códigos de Meta que significan "este token no ve ese objeto": se prueba el siguiente.
const RETRY_CODES = new Set([190, 10, 200, 294, 100, 803]);

// Ejecuta fn(token) con el token correcto. Si un token venció lo marca
// como vencido; si no ve el objeto, prueba con los otros perfiles.
async function withToken(userId, accountId, fn) {
  const candidates = await candidateTokens(userId, accountId);
  if (!candidates.length) {
    throw Object.assign(new Error('No hay ninguna cuenta de Meta conectada. Agrega un perfil pegando tu token.'), { noProfile: true, status: 404 });
  }
  let lastErr, expiredErr;
  for (const c of candidates) {
    try {
      return await fn(c.token, c);
    } catch (err) {
      lastErr = err;
      const m = metaError(err);
      if (m.code === 190) {
        expiredErr = Object.assign(
          new Error(`El token del perfil "${c.name}" venció, fue revocado o no es válido. Pega un token nuevo en Integraciones → Meta Ads.`),
          { metaCode: 190 });
        expiredErr.metaMessage = expiredErr.message;
        if (c.profileId) await markExpired(c.profileId, expiredErr.message);
      }
      if (!RETRY_CODES.has(m.code)) throw err; // error distinto (p. ej. límite de velocidad): no sirve probar otros tokens
    }
  }
  // Ningún perfil pudo: si alguno estaba vencido, ese es el aviso útil.
  throw expiredErr || lastErr;
}

// Responde con un error entendible (sin exponer datos internos).
function sendError(res, err, fallback) {
  if (err?.noProfile) return res.status(404).json({ error: err.message });
  const m = metaError(err);
  return res.status(400).json({ error: m.message || fallback });
}

module.exports = {
  GRAPH, GRAPH_VERSION, encrypt, decrypt, metaError, fetchProfileFromMeta, saveAccounts,
  getProfilesWithTokens, tokenForAccount, markExpired, listAllAccounts,
  legacyToken, candidateTokens, withToken, sendError
};
