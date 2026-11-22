// Envíos masivos: el que los va mandando poco a poco.
//
// Un envío no sale de golpe. Se guarda con su configuración (cuándo
// empieza, cada cuánto manda, en qué horario y cuántos por día) y este
// servicio despacha un mensaje cada vez, respetando todo eso. Así el
// número no se quema y el envío puede programarse para más tarde.
//
// Corre dentro del mismo proceso del servidor: cada pocos segundos mira
// si hay algo que mandar.

const supabase = require('../models/supabase');
const axios = require('axios');

const GRAPH = 'https://graph.facebook.com/v21.0';
const DIAS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];

/* ── Configuración ────────────────────────────────────────────── */

const VELOCIDADES = {
  rapido: [3, 8],
  normal: [5, 30],
  lento: [40, 120]
};

/** Deja la configuración del envío en una forma segura y completa. */
function normalizarConfig(c = {}) {
  const vel = VELOCIDADES[c.velocidad] ? c.velocidad : (c.velocidad === 'custom' ? 'custom' : 'normal');
  let [min, max] = VELOCIDADES[vel] || [Number(c.min), Number(c.max)];
  min = Math.max(0, Math.min(3600, Math.round(Number(min) || 0)));
  max = Math.max(min, Math.min(3600, Math.round(Number(max) || min)));
  const dias = Array.isArray(c.dias) ? c.dias.filter(d => DIAS.includes(d)) : ['lun', 'mar', 'mie', 'jue', 'vie'];
  return {
    velocidad: vel,
    min, max,
    aleatorio: c.aleatorio !== false,
    horario: c.horario === true,
    desde: /^\d{2}:\d{2}$/.test(c.desde) ? c.desde : '08:00',
    hasta: /^\d{2}:\d{2}$/.test(c.hasta) ? c.hasta : '18:00',
    dias: dias.length ? dias : ['lun', 'mar', 'mie', 'jue', 'vie'],
    maxPorDia: Math.max(0, Math.min(100000, Math.round(Number(c.maxPorDia) || 0))),
    zona: typeof c.zona === 'string' && c.zona ? c.zona : 'America/Lima'
  };
}

/** Los segundos que hay que esperar antes del siguiente mensaje. */
function esperaEntreMensajes(cfg) {
  if (!cfg.aleatorio || cfg.max === cfg.min) return cfg.min;
  return cfg.min + Math.random() * (cfg.max - cfg.min);
}

/** El día y el minuto de ahora, en la zona horaria del envío. */
function ahoraEn(zona) {
  try {
    const partes = new Intl.DateTimeFormat('en-US', {
      timeZone: zona, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const p = t => (partes.find(x => x.type === t) || {}).value || '';
    const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      dia: DIAS[dias[p('weekday')] ?? new Date().getDay()],
      minutos: (parseInt(p('hour'), 10) || 0) * 60 + (parseInt(p('minute'), 10) || 0),
      fecha: `${p('year')}-${p('month')}-${p('day')}`
    };
  } catch {
    const d = new Date();
    return { dia: DIAS[d.getDay()], minutos: d.getHours() * 60 + d.getMinutes(), fecha: d.toISOString().slice(0, 10) };
  }
}

const aMinutos = hhmm => {
  const [h, m] = String(hhmm).split(':');
  return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
};

/** ¿Se puede mandar ahora mismo? Devuelve null si sí, o el motivo. */
function porQueNoAhora(cfg, enviado) {
  const { dia, minutos, fecha } = ahoraEn(cfg.zona);
  if (cfg.maxPorDia > 0 && enviado.dia === fecha && enviado.cuantos >= cfg.maxPorDia) return 'limite_diario';
  if (!cfg.horario) return null;
  if (!cfg.dias.includes(dia)) return 'dia_no_permitido';
  const d = aMinutos(cfg.desde), h = aMinutos(cfg.hasta);
  const dentro = h > d ? (minutos >= d && minutos < h) : (minutos >= d || minutos < h);
  return dentro ? null : 'fuera_de_horario';
}

/* ── Enviar un mensaje ────────────────────────────────────────── */

async function mandarPlantilla(conn, telefono, plantilla, idioma) {
  await axios.post(`${GRAPH}/${conn.phone_number_id}/messages`, {
    messaging_product: 'whatsapp',
    to: telefono,
    type: 'template',
    template: { name: plantilla, language: { code: idioma || 'es' } }
  }, { headers: { Authorization: `Bearer ${conn.access_token}` }, timeout: 20000 });
}

/**
 * Manda el siguiente mensaje pendiente de un envío.
 * Devuelve 'enviado' | 'fallido' | 'vacio'.
 */
async function mandarSiguiente(envio, conn) {
  const { data: destinos } = await supabase
    .from('broadcast_targets')
    .select('id, contact_phone, contact_name')
    .eq('broadcast_id', envio.id)
    .eq('status', 'pendiente')
    .order('created_at', { ascending: true })
    .limit(1);

  const destino = destinos && destinos[0];
  if (!destino) return 'vacio';

  try {
    if (envio.flow_id) {
      await dispararFlujo(envio, conn, destino);
    } else {
      await mandarPlantilla(conn, destino.contact_phone, envio.template_name, envio.template_language);
    }
    await supabase.from('broadcast_targets')
      .update({ status: 'enviado', sent_at: new Date().toISOString() })
      .eq('id', destino.id);
    return 'enviado';
  } catch (e) {
    const msg = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
    await supabase.from('broadcast_targets')
      .update({ status: 'fallido', error: String(msg).slice(0, 500), sent_at: new Date().toISOString() })
      .eq('id', destino.id);
    return 'fallido';
  }
}

/**
 * Arranca un flujo con un contacto: busca (o crea) su conversación y
 * lo ejecuta igual que cuando el negocio elige un flujo desde el chat.
 */
async function dispararFlujo(envio, conn, destino) {
  const { data: flujo } = await supabase
    .from('flows').select('nodes').eq('id', envio.flow_id).eq('user_id', envio.user_id).single();
  const inicio = ((flujo && flujo.nodes) || []).find(n => n.type === 'start');
  if (!inicio) throw new Error('Ese flujo no tiene bloque de Inicio.');

  let { data: conv } = await supabase
    .from('conversations')
    .select('id, last_jid')
    .eq('user_id', envio.user_id)
    .eq('connection_id', conn.id)
    .eq('contact_phone', destino.contact_phone)
    .maybeSingle();

  if (!conv) {
    const { data: nueva, error } = await supabase.from('conversations').insert({
      user_id: envio.user_id,
      connection_id: conn.id,
      contact_phone: destino.contact_phone,
      contact_name: destino.contact_name || destino.contact_phone,
      status: 'active',
      unread_count: 0,
      flow_active: true
    }).select('id, last_jid').single();
    if (error) throw new Error('No se pudo abrir la conversación: ' + error.message);
    conv = nueva;
  } else {
    await supabase.from('conversations').update({ flow_active: true }).eq('id', conv.id);
  }

  const { executeFlow } = require('./flowEngine');
  const esCloudAPI = !!(conn.phone_number_id && conn.access_token);
  if (esCloudAPI) {
    await executeFlow(envio.flow_id, destino.contact_phone, '', conn, conv.id, inicio.id);
  } else {
    const { executeFlowBaileys, activeSessions } = require('./baileys');
    const sock = activeSessions[conn.id];
    if (!sock) throw new Error('La conexión por QR no está activa ahora mismo.');
    const jid = conv.last_jid || `${destino.contact_phone}@s.whatsapp.net`;
    await executeFlowBaileys(envio.flow_id, sock, jid, destino.contact_phone, '', conv.id, inicio.id);
  }
}

/* ── El ciclo ─────────────────────────────────────────────────── */

async function procesarUno(envio) {
  const cfg = normalizarConfig(envio.config);
  const { fecha } = ahoraEn(cfg.zona);
  const enviado = { dia: envio.day_key, cuantos: envio.sent_today || 0 };

  const motivo = porQueNoAhora(cfg, enviado);
  if (motivo) {
    // Se vuelve a mirar en cinco minutos; no hay prisa.
    await supabase.from('broadcast_logs')
      .update({ next_at: new Date(Date.now() + 5 * 60000).toISOString(), status: 'en_espera', last_error: null })
      .eq('id', envio.id);
    return;
  }

  const { data: conn } = await supabase
    .from('connections')
    .select('id, phone_number_id, access_token, connection_type')
    .eq('id', envio.connection_id)
    .single();

  if (!conn) {
    await supabase.from('broadcast_logs')
      .update({ status: 'fallido', last_error: 'La conexión ya no existe.', finished_at: new Date().toISOString() })
      .eq('id', envio.id);
    return;
  }

  const resultado = await mandarSiguiente(envio, conn);

  if (resultado === 'vacio') {
    await supabase.from('broadcast_logs')
      .update({ status: 'completado', finished_at: new Date().toISOString(), next_at: null })
      .eq('id', envio.id);
    return;
  }

  const mismoDia = envio.day_key === fecha;
  await supabase.from('broadcast_logs').update({
    status: 'en_progreso',
    started_at: envio.started_at || new Date().toISOString(),
    enviados: (envio.enviados || 0) + (resultado === 'enviado' ? 1 : 0),
    fallidos: (envio.fallidos || 0) + (resultado === 'fallido' ? 1 : 0),
    sent_today: (mismoDia ? envio.sent_today || 0 : 0) + 1,
    day_key: fecha,
    next_at: new Date(Date.now() + esperaEntreMensajes(cfg) * 1000).toISOString()
  }).eq('id', envio.id);
}

let corriendo = false;

async function tick() {
  if (corriendo) return;
  corriendo = true;
  try {
    const ahora = new Date().toISOString();
    const { data: envios } = await supabase
      .from('broadcast_logs')
      .select('*')
      .in('status', ['programado', 'en_progreso', 'en_espera'])
      .or(`next_at.is.null,next_at.lte.${ahora}`)
      .order('next_at', { ascending: true, nullsFirst: true })
      .limit(20);

    for (const envio of envios || []) {
      // Un envío programado para más tarde todavía no empieza.
      if (envio.scheduled_at && new Date(envio.scheduled_at) > new Date()) continue;
      try { await procesarUno(envio); }
      catch (e) { console.error(`[Envíos masivos] ${envio.id}:`, e.message); }
    }
  } catch (e) {
    console.error('[Envíos masivos] Error en el ciclo:', e.message);
  } finally {
    corriendo = false;
  }
}

/** Arranca el despachador. Se llama una vez al levantar el servidor. */
function arrancar(cada = 8000) {
  setInterval(() => { tick().catch(() => { }); }, cada);
  console.log('[Envíos masivos] Despachador activo');
}

module.exports = { arrancar, normalizarConfig, porQueNoAhora, esperaEntreMensajes, ahoraEn, VELOCIDADES };
