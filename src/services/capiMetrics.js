const supabase = require('../models/supabase');

// ════════════════════════════════════════════════════════════
// Métricas de Meta CAPI (WhatsApp API y QR) — por cada número/pixel.
// Cada venta confirmada queda guardada en purchase_events con su resultado en Meta.
// ════════════════════════════════════════════════════════════
const TZ_OFFSET_H = -5; // Lima (UTC-5, sin horario de verano)

function resultadoMeta(estado, tieneClid) {
  const e = String(estado || '');
  if (e === 'enviado') return 'accepted';
  if (/^error/i.test(e)) return 'rejected';
  if (/^omitido/i.test(e)) return 'omitted';
  return tieneClid ? 'pending' : 'omitted';
}

// Guarda la venta ANTES de enviarla a Meta. Devuelve el id del registro.
async function registrar(userId, conversation, monto, canal) {
  try {
    const { count } = await supabase.from('purchase_events').select('id', { count: 'exact', head: true }).eq('conversation_id', conversation.id);
    const { data } = await supabase.from('purchase_events').insert({
      user_id: userId, connection_id: conversation.connection_id || null, conversation_id: conversation.id,
      amount: parseFloat(monto) || 0, ctwa_clid: conversation.ctwa_clid || null, is_first: !count,
      arrived_at: conversation.created_at || null, purchased_at: new Date().toISOString(),
      channel: canal || null, meta_status: conversation.ctwa_clid ? 'pending' : 'omitted'
    }).select('id').single();
    return data?.id || null;
  } catch (e) { console.error('[CAPI métricas] registrar:', e.message); return null; }
}

// Después del envío: copia el resultado real que quedó en la conversación.
async function cerrar(eventoId, conversationId) {
  try {
    const { data: conv } = await supabase.from('conversations').select('meta_event_status, ctwa_clid').eq('id', conversationId).maybeSingle();
    let id = eventoId;
    if (!id) {
      const { data: ult } = await supabase.from('purchase_events').select('id').eq('conversation_id', conversationId).order('purchased_at', { ascending: false }).limit(1).maybeSingle();
      id = ult?.id;
    }
    if (!id) return;
    await supabase.from('purchase_events').update({
      meta_status: resultadoMeta(conv?.meta_event_status, !!conv?.ctwa_clid),
      meta_detail: conv?.meta_event_status ? String(conv.meta_event_status).slice(0, 300) : null
    }).eq('id', id);
  } catch (e) { console.error('[CAPI métricas] cerrar:', e.message); }
}

// ── Rango de fechas en hora de Lima ───────────────────────────
function rangoDe(query) {
  const ahora = new Date();
  const limaAhora = new Date(ahora.getTime() + TZ_OFFSET_H * 3600e3);
  const inicioHoyUtc = Date.UTC(limaAhora.getUTCFullYear(), limaAhora.getUTCMonth(), limaAhora.getUTCDate()) - TZ_OFFSET_H * 3600e3;
  const dia = 86400e3;
  const r = String(query.range || query.date_preset || 'today').toLowerCase();
  if (query.from && query.to) {
    const f = Date.parse(query.from + 'T00:00:00Z') - TZ_OFFSET_H * 3600e3;
    const t = Date.parse(query.to + 'T00:00:00Z') - TZ_OFFSET_H * 3600e3 + dia;
    if (!isNaN(f) && !isNaN(t)) return { from: new Date(f), to: new Date(t), range: 'custom' };
  }
  if (r === 'yesterday' || r === 'ayer') return { from: new Date(inicioHoyUtc - dia), to: new Date(inicioHoyUtc), range: 'yesterday' };
  if (r === '7d' || r === '7' || r === 'last_7d') return { from: new Date(inicioHoyUtc - 6 * dia), to: new Date(inicioHoyUtc + dia), range: '7d' };
  if (r === '30d' || r === '30' || r === 'last_30d') return { from: new Date(inicioHoyUtc - 29 * dia), to: new Date(inicioHoyUtc + dia), range: '30d' };
  return { from: new Date(inicioHoyUtc), to: new Date(inicioHoyUtc + dia), range: 'today' };
}

const VACIO = () => ({
  compras_generadas: 0,
  origen_publicitario: 0, aceptados: 0, captados_anteriormente: 0, sin_referencia: 0,
  pagos_confirmados: 0, monto_confirmado: 0, ventas_principales: 0, compras_adicionales: 0,
  meta: { enviados: 0, aceptados: 0, rechazados: 0, pendientes: 0 },
  monto_atribuido: 0
});

function calcular(eventos, from, to) {
  const m = VACIO();
  const origen = new Set(), aceptados = new Set(), anteriores = new Set(), sinRef = new Set();
  for (const e of eventos) {
    m.pagos_confirmados++;
    m.monto_confirmado += Number(e.amount) || 0;
    if (e.is_first) m.ventas_principales++; else m.compras_adicionales++;
    const conv = e.conversation_id;
    if (!e.ctwa_clid) { sinRef.add(conv); continue; }
    origen.add(conv);
    const llegada = e.arrived_at ? new Date(e.arrived_at) : null;
    const llegoEnPeriodo = llegada && llegada >= from && llegada < to;
    if (e.meta_status === 'accepted' && llegoEnPeriodo) { aceptados.add(conv); m.monto_atribuido += Number(e.amount) || 0; }
    if (llegada && llegada < from) anteriores.add(conv);
    if (e.meta_status === 'accepted') { m.meta.enviados++; m.meta.aceptados++; }
    else if (e.meta_status === 'rejected') { m.meta.enviados++; m.meta.rechazados++; }
    else if (e.meta_status === 'pending') m.meta.pendientes++;
  }
  m.origen_publicitario = origen.size;
  m.aceptados = aceptados.size;
  m.compras_generadas = aceptados.size;
  m.captados_anteriormente = anteriores.size;
  m.sin_referencia = sinRef.size;
  m.monto_confirmado = Number(m.monto_confirmado.toFixed(2));
  m.monto_atribuido = Number(m.monto_atribuido.toFixed(2));
  return m;
}

// Una fila por número: tipo (api/qr), si tiene pixel/dataset y sus métricas.
async function metricasPorNumero(userId, query) {
  const { from, to, range } = rangoDe(query);
  const [{ data: conexiones }, { data: capi }, { data: proyectos }] = await Promise.all([
    supabase.from('connections').select('id, name, phone_number, waba_id, connection_type, is_active').eq('user_id', userId),
    supabase.from('capi_connections').select('waba_id, dataset_id, event_token').eq('user_id', userId),
    supabase.from('capi_business_projects').select('id, dataset_id, access_token, connection_ids').eq('user_id', userId)
  ]);
  const { data: eventos } = await supabase.from('purchase_events')
    .select('connection_id, conversation_id, amount, ctwa_clid, is_first, arrived_at, meta_status')
    .eq('user_id', userId).gte('purchased_at', from.toISOString()).lt('purchased_at', to.toISOString()).limit(20000);

  // Ignorar ventas que después se rechazaron (is_sale=false)
  const ids = [...new Set((eventos || []).map(e => e.conversation_id))];
  const vigentes = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from('conversations').select('id').in('id', ids.slice(i, i + 200)).eq('is_sale', true);
    (data || []).forEach(c => vigentes.add(c.id));
  }
  const validos = (eventos || []).filter(e => vigentes.has(e.conversation_id));

  const numeros = (conexiones || []).map(c => {
    const esQr = c.connection_type === 'qr';
    let conectado = false, dataset = null;
    if (esQr) {
      const p = (proyectos || []).find(p => (p.connection_ids || []).includes(c.id));
      conectado = !!(p?.dataset_id && p?.access_token); dataset = p?.dataset_id || null;
    } else {
      const k = (capi || []).find(k => k.waba_id && k.waba_id === c.waba_id);
      conectado = !!(k?.dataset_id && k?.event_token); dataset = k?.dataset_id || null;
    }
    return {
      connection_id: c.id, name: c.name, phone_number: c.phone_number, type: esQr ? 'qr' : 'api',
      dataset_id: dataset, status: conectado ? 'connected' : 'missing_dataset',
      status_label: conectado ? 'Conectado a Meta' : 'Falta Dataset',
      metrics: calcular(validos.filter(e => e.connection_id === c.id), from, to)
    };
  });
  return { range, from: from.toISOString(), to: to.toISOString(), numbers: numeros, total: calcular(validos, from, to) };
}

module.exports = { registrar, cerrar, metricasPorNumero, rangoDe, calcular, resultadoMeta };
