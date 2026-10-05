// services/connectionStatus.js
// Estado real de cada número de WhatsApp API según Meta. Hay 4 formas de
// enterarse de un bloqueo, de la más rápida a la más lenta:
//   1. Webhook de Meta (account_update / phone_number_quality_update) → segundos
//   2. Un envío que Meta rechaza por cuenta bloqueada (error 131031)  → al instante
//   3. Cuando el usuario abre la pantalla de Conexiones                → segundos
//   4. Revisión automática cada pocos minutos (red de seguridad)       → minutos

const axios = require('axios');
const supabase = require('../models/supabase');

const GRAPH_VERSION = 'v26.0';

const COLUMNAS = 'id, name, phone_number, phone_number_id, waba_id, access_token, connection_type, is_active, meta_status, meta_quality, meta_status_checked_at, meta_status_error, blocked_detected_at';

// Solo BANNED/DELETED son "bloqueo" (rojo). RESTRICTED NO lo es: significa
// que se alcanzó el límite diario de mensajes.
function clasificar(status) {
  switch (String(status || '').toUpperCase()) {
    case 'CONNECTED':       return { severity: 'ok',      label: 'Conectado' };
    case 'BANNED':          return { severity: 'blocked', label: 'Bloqueado por Meta' };
    case 'DELETED':         return { severity: 'blocked', label: 'Número eliminado en Meta' };
    case 'PENDING_DISABLE': return { severity: 'warning', label: 'Meta programó bloquear esta cuenta' };
    case 'FLAGGED':         return { severity: 'warning', label: 'En observación (calidad baja)' };
    case 'RESTRICTED':      return { severity: 'warning', label: 'Límite de mensajes alcanzado' };
    case 'RATE_LIMITED':    return { severity: 'warning', label: 'Límite de velocidad de Meta' };
    case 'DISCONNECTED':    return { severity: 'warning', label: 'Desconectado' };
    case 'PENDING':
    case 'UNVERIFIED':      return { severity: 'warning', label: 'Pendiente de verificación' };
    case 'MIGRATED':        return { severity: 'warning', label: 'Migrado a otra cuenta' };
    default:                return { severity: 'unknown', label: 'Sin información' };
  }
}

// Pregunta a Meta por un número y guarda el resultado. Nunca lanza error.
async function revisarConexion(conn) {
  const ahora = new Date().toISOString();
  let cambios;
  try {
    const r = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${conn.phone_number_id}`, {
      params: { fields: 'status,quality_rating', access_token: conn.access_token },
      timeout: 12000
    });
    const status = String(r.data?.status || 'UNKNOWN').toUpperCase();
    const bloqueado = clasificar(status).severity === 'blocked';
    cambios = {
      meta_status: status,
      meta_quality: r.data?.quality_rating || null,
      meta_status_checked_at: ahora,
      meta_status_error: null,
      blocked_detected_at: bloqueado ? (conn.blocked_detected_at || ahora) : null
    };
  } catch (err) {
    const e = err.response?.data?.error || {};
    const texto = String(e.message || err.message || '');
    if (e.code === 131031 || /(account|number).*(locked|banned|disabled|suspended)/i.test(texto)) {
      cambios = {
        meta_status: 'BANNED', meta_status_checked_at: ahora,
        meta_status_error: texto.slice(0, 300),
        blocked_detected_at: conn.blocked_detected_at || ahora
      };
    } else {
      // Token vencido, falla temporal de Meta...: NO se pinta de rojo ni se
      // pisa el último estado conocido — solo se anota el error.
      cambios = {
        meta_status_checked_at: ahora,
        meta_status_error: (e.code === 190
          ? 'El token de esta conexión venció o fue revocado. Vuelve a conectarla.'
          : texto).slice(0, 300)
      };
    }
  }
  const { error } = await supabase.from('connections').update(cambios).eq('id', conn.id);
  if (error) console.error('[Conexiones] No se pudo guardar el estado:', error.message);
  return { ...conn, ...cambios };
}

// 1. Webhook de Meta. entry.id es el ID de la cuenta de WhatsApp Business.
async function manejarAlertaDeMeta(wabaId, change) {
  if (!wabaId || !change) return;
  const { data: conns } = await supabase.from('connections').select(COLUMNAS)
    .eq('waba_id', String(wabaId)).eq('connection_type', 'api');
  if (!conns?.length) return;

  const ahora = new Date().toISOString();
  const value = change.value || {};
  const estadoBan = value.ban_info?.waba_ban_state;

  if (change.field === 'account_update' && value.event === 'DISABLED_UPDATE' && estadoBan === 'DISABLE') {
    for (const c of conns) {
      await supabase.from('connections').update({
        meta_status: 'BANNED', meta_status_checked_at: ahora,
        meta_status_error: 'Meta desactivó esta cuenta de WhatsApp Business por infringir sus políticas.',
        blocked_detected_at: c.blocked_detected_at || ahora
      }).eq('id', c.id);
    }
    console.log(`[Conexiones] 🚫 Meta desactivó la cuenta ${wabaId} (${conns.length} número/s) — aviso por webhook`);
    return;
  }
  if (change.field === 'account_update' && value.event === 'DISABLED_UPDATE' && estadoBan === 'SCHEDULE_FOR_DISABLE') {
    for (const c of conns) {
      await supabase.from('connections').update({
        meta_status: 'PENDING_DISABLE', meta_status_checked_at: ahora,
        meta_status_error: 'Meta avisó que va a desactivar esta cuenta por infringir sus políticas.'
      }).eq('id', c.id);
    }
    console.log(`[Conexiones] ⚠️ Meta programó desactivar la cuenta ${wabaId} — aviso por webhook`);
    return;
  }
  // Cualquier otro aviso (REINSTATE, cambio de calidad/límite, restricciones...):
  // se le pregunta a Meta el estado real en ese momento.
  for (const c of conns) {
    if (c.phone_number_id && c.access_token) await revisarConexion(c);
  }
}

// 2. Un envío que Meta rechaza porque la cuenta está bloqueada.
async function avisarSiNumeroBloqueado(phoneNumberId, err) {
  try {
    const e = err?.response?.data?.error;
    if (!phoneNumberId || e?.code !== 131031) return;
    const { data: conn } = await supabase.from('connections')
      .select('id, meta_status, blocked_detected_at').eq('phone_number_id', String(phoneNumberId)).maybeSingle();
    if (!conn || conn.meta_status === 'BANNED') return;
    const ahora = new Date().toISOString();
    await supabase.from('connections').update({
      meta_status: 'BANNED', meta_status_checked_at: ahora,
      meta_status_error: 'Meta rechazó el envío: la cuenta de WhatsApp Business está bloqueada (error 131031).',
      blocked_detected_at: conn.blocked_detected_at || ahora
    }).eq('id', conn.id);
    console.log(`[Conexiones] 🚫 El número ${phoneNumberId} está bloqueado — detectado al intentar enviar`);
  } catch (_) { /* nunca debe afectar al envío */ }
}

// 4. Revisión automática de todos los números (red de seguridad).
let revisando = false;
async function revisarTodas() {
  if (revisando) return;
  revisando = true;
  try {
    const { data } = await supabase.from('connections').select(COLUMNAS).eq('connection_type', 'api').eq('is_active', true);
    for (const c of data || []) {
      if (!c.phone_number_id || !c.access_token) continue;
      const antes = c.meta_status;
      const despues = await revisarConexion(c);
      if (antes !== despues.meta_status) {
        console.log(`[Conexiones] ${c.name || c.phone_number}: estado ${antes || 'sin revisar'} → ${despues.meta_status}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (e) {
    console.error('[Conexiones] Error en la revisión automática:', e.message);
  } finally {
    revisando = false;
  }
}

module.exports = { COLUMNAS, clasificar, revisarConexion, manejarAlertaDeMeta, avisarSiNumeroBloqueado, revisarTodas };
