// Flujos estándar: los que el usuario configura en
// Configuración → Flujos estándar, uno por conexión de WhatsApp.
//
//   first → primer mensaje de un contacto nuevo
//   off   → mensaje recibido fuera del horario de atención
//   any   → cualquier mensaje que no haya activado ningún flujo
//
// Son el último recurso: si un disparador coincide, manda el disparador.
// La única excepción es `off`, que gana al comodín — para eso está.

const supabase = require('../models/supabase');

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// La configuración se lee poco y cambia poco: una caché corta evita
// una consulta extra en cada mensaje que entra.
const _cache = new Map();
const VIDA_CACHE = 60000;

async function ajustesDe(userId) {
  const guardado = _cache.get(userId);
  if (guardado && Date.now() - guardado.t < VIDA_CACHE) return guardado.sd;
  const { data } = await supabase.from('user_settings').select('data').eq('user_id', userId).maybeSingle();
  const sd = (data && data.data && data.data.settingsData) || {};
  if (_cache.size > 2000) _cache.clear();
  _cache.set(userId, { t: Date.now(), sd });
  return sd;
}

/** Olvida lo guardado de un usuario (al guardar su configuración). */
function limpiarCache(userId) {
  if (userId) _cache.delete(userId); else _cache.clear();
}

/** La hora y el día de hoy en la zona horaria de la empresa. */
function ahoraEnZona(zona) {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: zona || 'America/Lima',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    const parte = t => (f.find(p => p.type === t) || {}).value || '';
    const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const hora = parseInt(parte('hour'), 10) || 0;
    const minuto = parseInt(parte('minute'), 10) || 0;
    return { dia: dias[parte('weekday')] ?? new Date().getDay(), minutos: hora * 60 + minuto };
  } catch {
    const d = new Date();
    return { dia: d.getDay(), minutos: d.getHours() * 60 + d.getMinutes() };
  }
}

const aMinutos = hhmm => {
  const [h, m] = String(hhmm || '').split(':');
  const hh = parseInt(h, 10), mm = parseInt(m, 10);
  return Number.isFinite(hh) ? hh * 60 + (Number.isFinite(mm) ? mm : 0) : null;
};

/** ¿Estamos fuera del horario de atención? Si no hay horario, nunca. */
function fueraDeHorario(sd) {
  const horario = sd.workHours;
  if (!horario || horario.on !== true || !Array.isArray(horario.days)) return false;
  const zona = (sd.company && sd.company.timezone) || 'America/Lima';
  const { dia, minutos } = ahoraEnZona(zona);
  const hoy = horario.days.find(d => d && d.d === DIAS[dia]);
  if (!hoy || hoy.on === false) return true;        // día cerrado
  const desde = aMinutos(hoy.from), hasta = aMinutos(hoy.to);
  if (desde === null || hasta === null) return false;
  // Un turno que cruza la medianoche (22:00 → 06:00) también vale.
  return hasta > desde ? (minutos < desde || minutos >= hasta) : (minutos < desde && minutos >= hasta);
}

/** ¿Es el primer mensaje que manda este contacto? */
async function esPrimerMensaje(conversationId) {
  const { count } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('direction', 'inbound');
  return (count || 0) <= 1;
}

/**
 * Qué flujo estándar toca, si toca alguno.
 * Devuelve { flowId, motivo } o null.
 * `motivo` es 'fuera_de_horario' | 'contacto_nuevo' | 'sin_flujo'.
 */
async function resolver(userId, connectionId, conversationId) {
  try {
    const sd = await ajustesDe(userId);
    const cfg = (sd.defaultFlows || {})[connectionId];
    if (!cfg || typeof cfg !== 'object') return null;

    if (cfg.off && fueraDeHorario(sd)) return { flowId: cfg.off, motivo: 'fuera_de_horario' };
    if (cfg.first && conversationId && await esPrimerMensaje(conversationId)) {
      return { flowId: cfg.first, motivo: 'contacto_nuevo' };
    }
    if (cfg.any) return { flowId: cfg.any, motivo: 'sin_flujo' };
    return null;
  } catch (e) {
    console.error('[Flujos estándar] No se pudo resolver:', e.message);
    return null;
  }
}

module.exports = { resolver, fueraDeHorario, limpiarCache, ajustesDe };
