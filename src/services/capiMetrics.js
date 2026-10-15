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
async function registrar(userId, conversation, monto, canal, opts = {}) {
  try {
    const { count } = await supabase.from('purchase_events').select('id', { count: 'exact', head: true }).eq('conversation_id', conversation.id);
    const { data } = await supabase.from('purchase_events').insert({
      user_id: userId, connection_id: conversation.connection_id || null, conversation_id: conversation.id,
      amount: parseFloat(opts.amountPen ?? monto) || 0, currency_original: opts.currency || null, amount_original: opts.currency ? (parseFloat(monto) || 0) : null, ctwa_clid: conversation.ctwa_clid || null, is_first: !count,
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


// ════════════════════════════════════════════════════════════
// "Eventos enviados" de un número/pixel: tarjetas por período, gráfico de 30 días y tabla.
// ════════════════════════════════════════════════════════════
const ESTADOS = {
  accepted: { codigo: 'sent', etiqueta: 'Enviado' },
  rejected: { codigo: 'rejected', etiqueta: 'Rechazado' },
  pending: { codigo: 'pending', etiqueta: 'Pendiente' },
  omitted: { codigo: 'no_click', etiqueta: 'Sin clic en anuncio' }
};

async function idsVigentes(ids) {
  const vigentes = new Set();
  const lotes = [];
  for (let i = 0; i < ids.length; i += 200) lotes.push(ids.slice(i, i + 200));
  await Promise.all(lotes.map(async lote => {
    const { data } = await supabase.from('conversations').select('id').in('id', lote).eq('is_sale', true);
    (data || []).forEach(c => vigentes.add(c.id));
  }));
  return vigentes;
}

function tarjeta(eventos) {
  const t = { detectados: eventos.length, enviados_a_meta: 0, rechazados: 0, pendientes: 0, sin_clic: 0, monto: 0 };
  for (const e of eventos) {
    t.monto += Number(e.amount) || 0;
    if (!e.ctwa_clid) t.sin_clic++;
    else if (e.meta_status === 'accepted') t.enviados_a_meta++;
    else if (e.meta_status === 'rejected') t.rechazados++;
    else t.pendientes++;
  }
  t.monto = Number(t.monto.toFixed(2));
  return t;
}

const dia = ms => new Date(ms + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10); // día en hora de Lima

async function eventosDeNumero(userId, connectionId, query = {}) {
  const { data: con } = await supabase.from('connections').select('id, name, phone_number, connection_type').eq('id', connectionId).eq('user_id', userId).maybeSingle();
  if (!con) return null;

  const { data: todos } = await supabase.from('purchase_events')
    .select('id, conversation_id, amount, currency_original, amount_original, ctwa_clid, is_first, purchased_at, meta_status, meta_detail')
    .eq('user_id', userId).eq('connection_id', connectionId)
    .order('purchased_at', { ascending: false }).limit(50000);
  const lista = todos || [];
  const vigentes = await idsVigentes([...new Set(lista.map(e => e.conversation_id))]);
  const eventos = lista.filter(e => vigentes.has(e.conversation_id));

  const hoy = rangoDe({ range: 'today' }).from.getTime();
  const dentro = desde => eventos.filter(e => new Date(e.purchased_at).getTime() >= desde);
  const periodos = {
    hoy: tarjeta(dentro(hoy)),
    ultimos_7_dias: tarjeta(dentro(hoy - 6 * 86400e3)),
    ultimos_30_dias: tarjeta(dentro(hoy - 29 * 86400e3)),
    total_historico: tarjeta(eventos)
  };

  // Gráfico: últimos 30 días (incluye los días sin ventas)
  const serie = [];
  const mapa = {};
  for (let i = 29; i >= 0; i--) { const d = dia(hoy - i * 86400e3); mapa[d] = { fecha: d, detectados: 0, enviados: 0, sin_clic: 0, monto: 0 }; serie.push(mapa[d]); }
  for (const e of dentro(hoy - 29 * 86400e3)) {
    const d = dia(new Date(e.purchased_at).getTime());
    const f = mapa[d]; if (!f) continue;
    f.detectados++; f.monto += Number(e.amount) || 0;
    if (!e.ctwa_clid) f.sin_clic++; else if (e.meta_status === 'accepted') f.enviados++;
  }
  serie.forEach(f => { f.monto = Number(f.monto.toFixed(2)); });

  // Tabla paginada
  const limite = Math.min(Math.max(parseInt(query.limit) || 25, 1), 100);
  const pagina = Math.max(parseInt(query.page) || 1, 1);
  const filtro = String(query.status || '').toLowerCase();
  let filas = eventos;
  if (filtro === 'sent') filas = filas.filter(e => e.ctwa_clid && e.meta_status === 'accepted');
  else if (filtro === 'rejected') filas = filas.filter(e => e.ctwa_clid && e.meta_status === 'rejected');
  else if (filtro === 'pending') filas = filas.filter(e => e.ctwa_clid && e.meta_status === 'pending');
  else if (filtro === 'no_click') filas = filas.filter(e => !e.ctwa_clid);
  const total = filas.length;
  const pag = filas.slice((pagina - 1) * limite, pagina * limite);

  const convIds = [...new Set(pag.map(e => e.conversation_id))];
  const convs = {};
  if (convIds.length) {
    const { data } = await supabase.from('conversations')
      .select('id, contact_name, contact_phone, ad_name, campaign_name, ad_headline, operation_code, sale_method').in('id', convIds);
    (data || []).forEach(c => { convs[c.id] = c; });
  }
  const tipoConexion = con.connection_type === 'qr' ? 'WhatsApp QR' : 'WhatsApp API';
  const rows = pag.map(e => {
    const c = convs[e.conversation_id] || {};
    const est = !e.ctwa_clid ? ESTADOS.omitted : (ESTADOS[e.meta_status] || ESTADOS.pending);
    const origenAnuncio = e.ctwa_clid ? (c.ad_name || c.ad_headline || c.campaign_name || 'Anuncio de Meta') : 'Sin anuncio (orgánico)';
    return {
      id: e.id,
      conversation_id: e.conversation_id,
      fecha: e.purchased_at,
      estado: est.codigo,
      estado_label: est.etiqueta,
      estado_detalle: e.meta_status === 'rejected' ? (e.meta_detail || null) : null,
      origen: origenAnuncio,
      campana: c.campaign_name || null,
      canal: tipoConexion,
      contacto: c.contact_name || c.contact_phone || '—',
      telefono: c.contact_phone || null,
      monto: Number(e.amount_original ?? e.amount) || 0,
      moneda: e.currency_original || 'PEN',
      monto_soles: Number(e.amount) || 0,
      tipo: e.is_first ? 'Venta principal' : 'Compra adicional',
      ctwa_clid: e.ctwa_clid || null,
      ticket: c.operation_code || ('T-' + String(e.id).replace(/-/g, '').slice(0, 8).toUpperCase())
    };
  });

  return {
    connection: { id: con.id, name: con.name, phone_number: con.phone_number, type: con.connection_type === 'qr' ? 'qr' : 'api' },
    periodos, serie_30_dias: serie,
    tabla: { page: pagina, limit: limite, total, pages: Math.max(Math.ceil(total / limite), 1), rows }
  };
}

module.exports = { eventosDeNumero, registrar, cerrar, metricasPorNumero, rangoDe, calcular, resultadoMeta };
