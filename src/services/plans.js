// services/plans.js — planes, prueba gratuita, límites y suspensión
const supabase = require('../models/supabase');

const DIAS_PRUEBA = 7;
const DIAS_PLAN = 30;

// El plan se define por la cantidad de API (igual que el selector de la pantalla):
// 1 API = US$19 · n API = US$(n*30-21) → 2 = 39, 3 = 69, 4 = 99, 5 = 129…
// Cada API trae 1 QR (uso ilimitado). El calentamiento está desactivado por ahora (warmup: 0).
// daily = clientes nuevos automatizados por día en API (null = ilimitado); solo el plan de 1 API tiene tope de 150.
function planDesdeN(n) {
  n = Math.max(1, Math.min(99, Math.floor(Number(n) || 1)));
  const usd = n === 1 ? 19 : n * 30 - 21;
  return { clave: 'p' + usd, nombre: `Plan US$${usd} · ${n} ${n === 1 ? 'API' : 'APIs'}`, usd, api: n, qr: n, warmup: 0, daily: n === 1 ? 150 : null };
}
function planDesdeClave(clave) {
  const m = /^p(\d+)$/.exec(String(clave || ''));
  if (!m) return null;
  const usd = parseInt(m[1]);
  const n = usd === 19 ? 1 : (usd + 21) / 30;
  return Number.isInteger(n) && n >= 1 && n <= 99 ? planDesdeN(n) : null;
}
const PRUEBA = { nombre: 'Prueba gratuita', api: 1, qr: 1, warmup: 0, daily: 150 };
const PLANES = { trial: PRUEBA };
// Cuentas anteriores a los planes: sin límites
const SIN_LIMITES = new Set(['legacy', 'pro', 'enterprise']);

const cache = new Map(); // userId -> { t, v }
const TTL = 15000;
function limpiarCache(userId) { cache.delete(String(userId)); }

function desde(u) {
  const ahora = Date.now();
  const extras = { api: u.extra_api || 0, qr: u.extra_qr || 0, warmup: u.extra_warmup || 0 };
  if (SIN_LIMITES.has(u.plan)) {
    return { plan: u.plan, planNombre: 'Plan sin límites', status: 'active', suspended: false, reason: null,
      trialEndsAt: null, expiresAt: u.subscription_expires_at || null, daysLeft: null,
      limits: { api: 9999, qr: 9999, warmup: 9999, daily: null }, unlimited: true, extras };
  }
  const pago = planDesdeClave(u.plan);
  const esPrueba = !pago;
  const clave = esPrueba ? 'trial' : pago.clave;
  const base = esPrueba ? PRUEBA : pago;
  const fin = esPrueba ? u.trial_ends_at : u.subscription_expires_at;
  const finMs = fin ? new Date(fin).getTime() : 0;
  const vigente = finMs > ahora;
  const daysLeft = vigente ? Math.ceil((finMs - ahora) / 86400000) : 0;
  return {
    plan: clave, planNombre: base.nombre,
    status: vigente ? (esPrueba ? 'trialing' : 'active') : 'suspended',
    suspended: !vigente,
    reason: vigente ? null : (esPrueba ? 'trial_ended' : 'plan_expired'),
    trialEndsAt: u.trial_ends_at || null, expiresAt: u.subscription_expires_at || null, daysLeft,
    // Los extras solo se suman en planes de pago
    limits: {
      api: base.api + (esPrueba ? 0 : extras.api),
      qr: base.qr + (esPrueba ? 0 : extras.qr),
      warmup: base.warmup + (esPrueba ? 0 : extras.warmup),
      daily: base.daily
    },
    unlimited: false, extras
  };
}

async function estadoCuenta(userId) {
  const key = String(userId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const { data: u } = await supabase.from('users')
    .select('id,plan,trial_ends_at,subscription_expires_at,extra_api,extra_qr,extra_warmup')
    .eq('id', userId).maybeSingle();
  const v = desde(u || { plan: 'legacy' });
  cache.set(key, { t: Date.now(), v });
  return v;
}

// Roles de calentamiento guardados en la configuración del usuario
async function rolesDe(userId) {
  const { data } = await supabase.from('user_settings').select('data').eq('user_id', userId).maybeSingle();
  const roles = data?.data?.settingsData?.connectionRoles;
  return roles && typeof roles === 'object' ? roles : {};
}

async function uso(userId) {
  const [{ data: cons }, roles] = await Promise.all([
    supabase.from('connections').select('id,connection_type').eq('user_id', userId),
    rolesDe(userId)
  ]);
  const lista = cons || [];
  const warm = lista.filter(c => (c.connection_type || 'api') !== 'qr' && roles[c.id] === 'warmup').length;
  const api = lista.filter(c => (c.connection_type || 'api') !== 'qr').length - warm;
  const qr = lista.filter(c => c.connection_type === 'qr').length;
  return { api, qr, warmup: warm, ids: lista.map(c => c.id) };
}

// ¿Puede crear otra conexión de este tipo? tipo: 'api' | 'qr'; rol: 'primary' | 'warmup'
async function puedeConectar(userId, tipo, rol = 'primary') {
  const e = await estadoCuenta(userId);
  if (e.suspended) return { ok: false, code: 'PLAN_SUSPENDED', message: mensajeSuspension(e) };
  if (e.unlimited) return { ok: true };
  const u = await uso(userId);
  if (tipo === 'qr') {
    if (u.qr >= e.limits.qr) return { ok: false, code: 'LIMIT_QR', message: `Tu plan incluye ${e.limits.qr} número(s) por QR y ya los usaste. Cambia de plan o agrega más.` };
  } else if (rol === 'warmup') {
    if (e.limits.warmup <= 0) return { ok: false, code: 'NO_WARMUP', message: 'Tu plan no incluye números de calentamiento. Contrata un plan de pago para usarlos.' };
    if (u.warmup >= e.limits.warmup) return { ok: false, code: 'LIMIT_WARMUP', message: `Tu plan incluye ${e.limits.warmup} número(s) de calentamiento y ya los usaste.` };
  } else if (u.api >= e.limits.api) {
    return { ok: false, code: 'LIMIT_API', message: `Tu plan incluye ${e.limits.api} API oficial(es) y ya las usaste. Cambia de plan o agrega más.` };
  }
  return { ok: true };
}

function mensajeSuspension(e) {
  return e.reason === 'trial_ended'
    ? 'Tu prueba gratuita terminó. Cambia de plan para volver a usar el bot, enviar mensajes y conectar números.'
    : 'Tu plan venció. Renuévalo para volver a usar el bot, enviar mensajes y conectar números.';
}

// Middleware para rutas que escriben (enviar mensajes, conectar números…)
function requireActive(req, res, next) {
  estadoCuenta(req.user.id).then(e => {
    if (e.suspended) return res.status(402).json({ error: mensajeSuspension(e), code: 'PLAN_SUSPENDED', reason: e.reason });
    next();
  }).catch(err => { console.error('[Plans] requireActive falló, se deja pasar:', err.message); next(); });
}

async function botPermitido(userId) {
  try { return !(await estadoCuenta(userId)).suspended; } catch { return true; }
}

function inicioDiaLima() {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
  return new Date(`${f}T00:00:00-05:00`);
}
function esDeHoyLima(fecha) { return !!fecha && new Date(fecha) >= inicioDiaLima(); }

// Se llama al crear una conversación nueva en una conexión API.
// Devuelve true si ya se pasó el tope diario (el bot no debe responder a este cliente).
async function pasoTopeDiario(userId, conversationId) {
  try {
    const e = await estadoCuenta(userId);
    if (!e.limits.daily) return false;
    const { data: cons } = await supabase.from('connections').select('id,connection_type').eq('user_id', userId);
    const apiIds = (cons || []).filter(c => (c.connection_type || 'api') !== 'qr').map(c => c.id);
    if (!apiIds.length) return false;
    const { count } = await supabase.from('conversations').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).in('connection_id', apiIds).gte('created_at', inicioDiaLima().toISOString());
    if ((count || 0) > e.limits.daily) {
      await supabase.from('conversations').update({ daily_limit_blocked: true }).eq('id', conversationId);
      return true;
    }
    return false;
  } catch (err) { console.error('[Plans] pasoTopeDiario:', err.message); return false; }
}

// ── Activación ──────────────────────────────────────────────────
async function activarPlan(userId, planKey, extras = null) {
  const texto = String(planKey);
  const p = planDesdeClave(/^\d+$/.test(texto) ? 'p' + texto : texto);
  if (!p) throw new Error('Plan desconocido: ' + planKey);
  const { data: u } = await supabase.from('users').select('subscription_expires_at').eq('id', userId).maybeSingle();
  const base = Math.max(Date.now(), u?.subscription_expires_at ? new Date(u.subscription_expires_at).getTime() : 0);
  const cambios = { plan: p.clave, subscription_expires_at: new Date(base + DIAS_PLAN * 86400000).toISOString() };
  if (extras) {
    cambios.extra_api = Math.max(0, parseInt(extras.api) || 0);
    cambios.extra_qr = Math.max(0, parseInt(extras.qr) || 0);
    cambios.extra_warmup = Math.max(0, parseInt(extras.warmup) || 0);
  }
  const { error } = await supabase.from('users').update(cambios).eq('id', userId);
  if (error) throw error;
  limpiarCache(userId);
  return cambios;
}

async function sumarExtra(userId, tipo, cantidad) {
  const col = { api: 'extra_api', qr: 'extra_qr', warmup: 'extra_warmup' }[tipo];
  if (!col) throw new Error('Extra desconocido: ' + tipo);
  const { data: u } = await supabase.from('users').select(col).eq('id', userId).maybeSingle();
  await supabase.from('users').update({ [col]: (u?.[col] || 0) + Math.max(1, parseInt(cantidad) || 1) }).eq('id', userId);
  limpiarCache(userId);
}

// Guarda el rol de una conexión (calentamiento) directamente en la configuración del usuario.
async function marcarRol(userId, connectionId, rol) {
  for (let intento = 0; intento < 4; intento++) {
    const { data: fila } = await supabase.from('user_settings').select('data,revision').eq('user_id', userId).maybeSingle();
    const revision = fila?.revision ?? 0;
    const data = fila?.data && typeof fila.data === 'object' ? fila.data : { settingsData: {}, quickReplies: [], labels: [] };
    data.settingsData = { ...(data.settingsData || {}) };
    data.settingsData.connectionRoles = { ...(data.settingsData.connectionRoles || {}), [connectionId]: rol };
    const cambios = { data, revision: revision + 1, updated_at: new Date().toISOString() };
    const r = revision === 0
      ? await supabase.from('user_settings').insert({ ...cambios, user_id: userId }).select('revision').maybeSingle()
      : await supabase.from('user_settings').update(cambios).eq('user_id', userId).eq('revision', revision).select('revision').maybeSingle();
    if (!r.error && r.data) return true;
  }
  return false;
}

async function enlacesHotmart(userId) {
  let mapa = {};
  try { mapa = JSON.parse(process.env.HOTMART_CHECKOUTS || '{}'); } catch { return {}; }
  const { data: u } = await supabase.from('users').select('email,name').eq('id', userId).maybeSingle();
  const out = {};
  for (const [n, url] of Object.entries(mapa)) {
    try {
      const link = new URL(url);
      // El correo del pago debe coincidir con el de la cuenta para activar el plan solo
      if (u?.email) link.searchParams.set('email', u.email);
      if (u?.name) link.searchParams.set('name', u.name);
      out[n] = link.href;
    } catch { /* enlace inválido: se omite */ }
  }
  return out;
}

// Estructura que espera la página Cobranza del frontend
async function billingParaFrontend(userId) {
  const e = await estadoCuenta(userId);
  const u = await uso(userId);
  const vacio = n => (e.unlimited ? null : n);
  // Avisos de vencimiento: la tarjeta de planes se oculta con un plan pagado y reaparece 3 días antes de vencer;
  // desde 7 días antes se muestra un recordatorio ("Te quedan N días…") cada vez que la persona entra.
  const d = e.daysLeft;
  let showBanner = true, reminder = null;
  if (e.unlimited) { showBanner = false; }
  else if (e.suspended) { reminder = mensajeSuspension(e); }
  else if (e.status === 'active') {
    showBanner = d <= 3;
    if (d <= 7) reminder = d <= 1 ? 'Tu plan vence hoy o mañana. Renueva para no perder el servicio.' : `Te quedan ${d} días para que venza tu plan.`;
  } else {
    reminder = d <= 1 ? 'Tu prueba gratuita termina hoy o mañana.' : `Te quedan ${d} días de prueba gratuita.`;
  }
  return {
    subscription: {
      show_banner: showBanner, reminder,
      status: e.status, plan: e.plan, plan_name: e.planNombre,
      api_count: e.limits.api, suspended: e.suspended, reason: e.reason,
      trial_ends_at: e.trialEndsAt, expires_at: e.expiresAt, days_left: e.daysLeft,
      daily_new_clients_limit: e.limits.daily,
      channels: {
        api: { limit: vacio(e.limits.api), used: u.api },
        qr: { limit: vacio(e.limits.qr), used: u.qr },
        warmup: { limit: vacio(e.limits.warmup), used: u.warmup }
      }
    },
    invoices: [],
    // Enlaces de pago de Hotmart (exterior) por cantidad de API. Variable HOTMART_CHECKOUTS: {"1":"https://pay.hotmart.com/…","2":"…"}
    checkout_urls: await enlacesHotmart(userId),
    plans_url: process.env.BILLING_PLANS_URL || null,
    portal_url: process.env.BILLING_PORTAL_URL || null,
    support_url: process.env.SUPPORT_URL || null
  };
}

module.exports = {
  PLANES, planDesdeN, planDesdeClave, DIAS_PRUEBA, DIAS_PLAN,
  estadoCuenta, limpiarCache, uso, rolesDe, puedeConectar, requireActive, botPermitido,
  esDeHoyLima, pasoTopeDiario, marcarRol, activarPlan, sumarExtra, billingParaFrontend, mensajeSuspension
};
