const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const axios = require('axios');
const { sendManualTextBaileys, sendManualMediaBaileys, executeFlowBaileys, activeSessions } = require('../services/baileys');
const {
  sendWhatsAppImage, sendWhatsAppVideo, sendWhatsAppAudio, sendWhatsAppDocument, sendPurchaseEventToMeta, executeFlow
} = require('../services/flowEngine');

// ── Conversión de moneda real para el Dashboard ─────────────────
// Todos los montos de venta se guardan en Soles (PEN), la moneda del
// negocio. Cuando el usuario elige ver el Dashboard en otra moneda,
// convertimos de verdad usando tasas de cambio reales — antes solo
// se cambiaba la etiqueta sin convertir el número.
// API gratuita, sin key, 166 monedas: https://www.exchangerate-api.com/docs/free
let cacheTasasCambio = { rates: null, fetchedAt: 0 };
const UNA_HORA_MS = 60 * 60 * 1000;

async function obtenerTasasCambio() {
  const ahora = Date.now();
  if (cacheTasasCambio.rates && (ahora - cacheTasasCambio.fetchedAt) < UNA_HORA_MS) {
    return cacheTasasCambio.rates;
  }
  try {
    const { data } = await axios.get('https://open.er-api.com/v6/latest/PEN', { timeout: 8000 });
    if (data?.result === 'success' && data.rates) {
      cacheTasasCambio = { rates: data.rates, fetchedAt: ahora };
      return data.rates;
    }
  } catch (e) {
    console.error('[Dashboard] Error obteniendo tasas de cambio:', e.message);
  }
  // Si falla la API y hay un caché viejo, mejor usarlo que no convertir nada
  return cacheTasasCambio.rates || null;
}

async function convertirDesdeSoles(monto, monedaDestino) {
  if (!monedaDestino || monedaDestino === 'PEN') return monto;
  const rates = await obtenerTasasCambio();
  if (!rates || !rates[monedaDestino]) return monto; // sin tasa disponible, devuelve el original sin convertir
  return monto * rates[monedaDestino];
}
router.use(auth);
// ── GET /api/conversations ────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const offset = (page - 1) * limit;
    const { data, error, count } = await supabase
      .from('conversations')
      .select(`
        id, contact_phone, contact_name, last_message,
        last_message_at, unread_count, status, connection_id, tag, profile_pic_url, flow_active, last_message_direction, bot_ever_responded, ever_replied,
        connections(name)
      `, { count: 'exact' })
      .eq('user_id', req.user.id)
      .order('last_message_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    res.json({ data, total: count, page: +page, limit: +limit });
  } catch (err) { next(err); }
});

// ── POST /api/conversations/:id/messages (envío manual) ───────
router.post('/:id/messages', async (req, res, next) => {
  try {
    const { content, direction = 'outbound', media_url, media_type, file_name } = req.body;
    const esMedia = !!media_url;
    if (!content && !esMedia) return res.status(400).json({ error: 'content o media_url requerido' });

    const { data: conv } = await supabase
      .from('conversations')
      .select('*, connections(*)')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

    // Enviar por WhatsApp si es outbound — detecta el TIPO de conexión
    // (QR/Baileys vs WhatsApp Cloud API) y usa el canal correcto.
    // Antes esto SIEMPRE intentaba mandar por Cloud API sin importar
    // el tipo, así que para conexiones QR nunca llegaba de verdad,
    // aunque el mensaje sí se guardaba como si hubiera funcionado.
    if (direction === 'outbound' && conv.connections) {
      const esCloudAPI = !!(conv.connections.phone_number_id && conv.connections.access_token);

      if (esCloudAPI) {
        try {
          if (esMedia) {
            const { phone_number_id: pnid, access_token: tok } = conv.connections;
            if (media_type === 'image') await sendWhatsAppImage(pnid, tok, conv.contact_phone, media_url, content || '', null);
            else if (media_type === 'video') await sendWhatsAppVideo(pnid, tok, conv.contact_phone, media_url, content || '', null);
            else if (media_type === 'audio') await sendWhatsAppAudio(pnid, tok, conv.contact_phone, media_url, null);
            else if (media_type === 'document') await sendWhatsAppDocument(pnid, tok, conv.contact_phone, media_url, file_name || '', null);
          } else {
            await axios.post(
              `https://graph.facebook.com/v19.0/${conv.connections.phone_number_id}/messages`,
              { messaging_product: 'whatsapp', to: conv.contact_phone, type: 'text', text: { body: content } },
              { headers: { Authorization: `Bearer ${conv.connections.access_token}`, 'Content-Type': 'application/json' } }
            );
          }
        } catch (e) {
          console.error('[Manual send error - Cloud API]', e.response?.data || e.message);
        }
      } else {
        // Conexión QR (Baileys) — usa el jid exacto guardado (puede ser
        // @lid en vez de @s.whatsapp.net), si ya lo tenemos registrado.
        const result = esMedia
          ? await sendManualMediaBaileys(conv.connection_id, conv.contact_phone, media_type, media_url, { caption: content, fileName: file_name }, conv.last_jid)
          : await sendManualTextBaileys(conv.connection_id, conv.contact_phone, content, req.params.id, conv.last_jid);
        if (!result.success) {
          console.error('[Manual send error - QR]', result.error);
        }
      }
    }

    const contentGuardado = content || (media_type === 'document' ? `[Documento: ${file_name || 'archivo'}]` : `[${(media_type || 'Media').replace(/^\w/, c => c.toUpperCase())}]`);

    const { data: msg, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: req.params.id,
        content: contentGuardado,
        direction,
        msg_type: esMedia ? media_type : 'text',
        media_url: esMedia ? media_url : null,
        created_at: new Date().toISOString()
      })
      .select()
      .single();
    if (error) throw error;

    await supabase.from('conversations').update({
      last_message: contentGuardado.slice(0, 100),
      last_message_at: new Date().toISOString(),
      last_message_direction: direction,
      ...(direction === 'outbound' ? { bot_ever_responded: true } : {})
    }).eq('id', req.params.id);

    res.status(201).json(msg);
  } catch (err) { next(err); }
});

// ── GET /api/conversations/:id/messages ───────────────────────
router.get('/:id/messages', async (req, res, next) => {
  try {
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    // Marcar como leído no necesita bloquear la respuesta — el usuario
    // ya tiene sus mensajes, esto puede terminar de guardarse en paralelo.
    supabase.from('conversations').update({ unread_count: 0 }).eq('id', req.params.id).then(() => {}).catch(() => {});
    res.json(data);
  } catch (err) { next(err); }
});

// ── Calcular "medianoche de hoy" en hora de Perú (America/Lima,
// UTC-5 fijo, sin horario de verano) — sin esto, el servidor usa su
// propia zona horaria (normalmente UTC en Railway), y "HOY" no
// coincide con el día real del negocio, dando números que no cuadran
// entre las tarjetas "HOY" y "30D" incluso el primer día de uso.
function inicioDeHoyLima() {
  const ahoraUTC = Date.now();
  const limaMs = ahoraUTC - 5 * 60 * 60 * 1000; // hora de Lima, en timestamp
  const limaDate = new Date(limaMs);
  const y = limaDate.getUTCFullYear();
  const m = limaDate.getUTCMonth();
  const d = limaDate.getUTCDate();
  // 00:00 en Lima equivale a 05:00 UTC del mismo día
  return new Date(Date.UTC(y, m, d, 5, 0, 0, 0));
}

// ── GET /api/conversations/stats/summary ─────────────────────
router.get('/stats/summary', async (req, res, next) => {
  try {
    const today = inicioDeHoyLima();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
    const [
      { count: total },
      { count: today_count },
      { count: active },
      { count: last30 }
    ] = await Promise.all([
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).gte('created_at', today.toISOString()),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('status', 'active'),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).gte('created_at', thirtyDaysAgo.toISOString())
    ]);
    const { count: msgs_today } = await supabase
      .from('messages')
      .select('conversations!inner(user_id)', { count: 'exact', head: true })
      .eq('conversations.user_id', req.user.id)
      .gte('created_at', today.toISOString());
    res.json({ total, today: today_count, active, messages_today: msgs_today, last_30_days: last30 });
  } catch (err) { next(err); }
});

// ── GET /api/conversations/dashboard ─────────────────────────
// ── Calcula el rango de fechas [desde, hasta] según el preset
// elegido en el botón "Fecha" del Dashboard. Todo en hora de Lima.
function calcularRangoFechas(range, fromParam, toParam) {
  const inicioHoy = inicioDeHoyLima(); // 00:00 de hoy, en Lima
  const ahora = new Date();

  switch (range) {
    case 'yesterday': {
      const desde = new Date(inicioHoy);
      desde.setUTCDate(desde.getUTCDate() - 1);
      return { desde, hasta: inicioHoy }; // ayer completo, hasta las 00:00 de hoy
    }
    case '7d': {
      const desde = new Date(inicioHoy);
      desde.setUTCDate(desde.getUTCDate() - 7);
      return { desde, hasta: ahora };
    }
    case '14d': {
      const desde = new Date(inicioHoy);
      desde.setUTCDate(desde.getUTCDate() - 14);
      return { desde, hasta: ahora };
    }
    case '30d': {
      // Rango fijo de 30 días — lo usan los 2 gráficos de abajo del
      // Dashboard ("Contactos y ventas últimos 30 días" / "Ingresos
      // últimos 30 días"), que NO cambian con el botón "Fecha".
      const desde = new Date(inicioHoy);
      desde.setUTCDate(desde.getUTCDate() - 30);
      return { desde, hasta: ahora };
    }
    case 'last_month': {
      // Primer y último día del mes calendario ANTERIOR, en hora de Lima
      const limaMs = inicioHoy.getTime();
      const limaDate = new Date(limaMs);
      const y = limaDate.getUTCFullYear();
      const m = limaDate.getUTCMonth(); // mes actual (0-indexado)
      const desde = new Date(Date.UTC(y, m - 1, 1, 5, 0, 0, 0)); // 1ro del mes pasado, 00:00 Lima
      const hasta = new Date(Date.UTC(y, m, 1, 5, 0, 0, 0)); // 1ro de este mes, 00:00 Lima (límite exclusivo)
      return { desde, hasta };
    }
    case 'custom': {
      const desde = fromParam ? new Date(fromParam) : inicioHoy;
      // "hasta" incluye el día completo indicado (hasta las 23:59:59)
      const hasta = toParam ? new Date(new Date(toParam).getTime() + 24 * 60 * 60 * 1000) : ahora;
      return { desde, hasta };
    }
    case 'all': {
      // "TODO" — suma absolutamente todo el histórico, sin límite de
      // fecha hacia atrás.
      return { desde: new Date('2000-01-01T00:00:00.000Z'), hasta: ahora };
    }
    case 'today':
    default:
      return { desde: inicioHoy, hasta: ahora };
  }
}

router.get('/dashboard/stats', async (req, res, next) => {
  try {
    const { range = 'today', from, to } = req.query;
    const { desde, hasta } = calcularRangoFechas(range, from, to);

    const [
      { count: total_conversations },
      { count: active_conversations },
      { count: messages },
      { count: sales },
      { count: pending },
      { data: salesData },
      { data: convByDay }
    ] = await Promise.all([
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).gte('created_at', desde.toISOString()).lte('created_at', hasta.toISOString()),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('status', 'active'),
      supabase.from('messages').select('conversations!inner(user_id)', { count: 'exact', head: true }).eq('conversations.user_id', req.user.id).gte('created_at', desde.toISOString()).lte('created_at', hasta.toISOString()),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('is_sale', true).gte('sale_at', desde.toISOString()).lte('sale_at', hasta.toISOString()),
      // "Pendientes" = se le pidió el pago (payment_requested_at) pero
      // todavía no se confirmó la venta (is_sale sigue en false).
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('is_sale', false).not('payment_requested_at', 'is', null).gte('payment_requested_at', desde.toISOString()).lte('payment_requested_at', hasta.toISOString()),
      supabase.from('conversations').select('sale_amount, sale_at').eq('user_id', req.user.id).eq('is_sale', true).gte('sale_at', desde.toISOString()).lte('sale_at', hasta.toISOString()),
      supabase.from('conversations').select('created_at').eq('user_id', req.user.id).gte('created_at', desde.toISOString()).lte('created_at', hasta.toISOString()).order('created_at', { ascending: true })
    ]);

    const total_revenue = (salesData || []).reduce((sum, s) => sum + (s.sale_amount || 0), 0);
    const avg_ticket = sales > 0 ? total_revenue / sales : 0;
    const conversion_rate = total_conversations > 0 ? ((sales / total_conversations) * 100).toFixed(1) : 0;

    // Fecha (YYYY-MM-DD) en hora de Lima — la fecha "cruda" del
    // timestamp UTC puede caer en el día equivocado cerca de la
    // medianoche si no se convierte primero.
    function fechaLimaYMD(fechaISO) {
      const ms = new Date(fechaISO).getTime() - 5 * 60 * 60 * 1000;
      return new Date(ms).toISOString().split('T')[0];
    }
    function diaSemanaLima(fechaISO) {
      const ms = new Date(fechaISO).getTime() - 5 * 60 * 60 * 1000;
      return new Date(ms).getUTCDay();
    }

    // Gráfico diario — siempre un punto por día dentro del rango
    // elegido (sin importar si el rango es corto, como Hoy). Esto es
    // lo que usan las mini-gráficas (sparklines) de cada tarjeta.
    const chart_granularity = 'daily';
    // Si el rango es muy largo (ej. "TODO" o un "personalizado" de
    // varios meses/años), lo topamos en 90 días para no reventar la
    // respuesta.
    const diasEnRango = Math.min(Math.ceil((hasta - desde) / (24 * 60 * 60 * 1000)) + 1, 90);
    const dailyMap = {};
    for (let i = 0; i < diasEnRango; i++) {
      const d = new Date(desde);
      d.setUTCDate(d.getUTCDate() + i);
      const key = d.toISOString().split('T')[0];
      dailyMap[key] = { date: key, conversations: 0, sales: 0, revenue: 0 };
    }
    (convByDay || []).forEach(c => {
      const key = fechaLimaYMD(c.created_at);
      if (dailyMap[key]) dailyMap[key].conversations++;
    });
    (salesData || []).forEach(s => {
      if (!s.sale_at) return;
      const key = fechaLimaYMD(s.sale_at);
      if (dailyMap[key]) {
        dailyMap[key].sales++;
        dailyMap[key].revenue += (s.sale_amount || 0);
      }
    });
    const daily_chart = Object.values(dailyMap).map(d => ({ ...d, revenue: Number(d.revenue.toFixed(2)) }));

    // Ventas/contactos por día de la semana, dentro del mismo rango.
    const weekdays = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const byWeekday = weekdays.map(day => ({ day, sales: 0, conversations: 0 }));
    (convByDay || []).forEach(c => {
      byWeekday[diaSemanaLima(c.created_at)].conversations++;
    });
    (salesData || []).forEach(s => {
      if (!s.sale_at) return;
      byWeekday[diaSemanaLima(s.sale_at)].sales++;
    });

    // Todos los montos se calcularon en Soles (PEN) — si el frontend
    // pidió otra moneda (?currency=USD), se convierten de verdad acá,
    // con tasas de cambio reales, antes de responder.
    const monedaSolicitada = (req.query.currency || 'PEN').toUpperCase();
    const [total_revenue_conv, avg_ticket_conv] = await Promise.all([
      convertirDesdeSoles(total_revenue, monedaSolicitada),
      convertirDesdeSoles(avg_ticket, monedaSolicitada)
    ]);
    const tasaParaChart = monedaSolicitada === 'PEN' ? 1 : (await obtenerTasasCambio())?.[monedaSolicitada] || 1;
    const daily_chart_convertido = daily_chart.map(d => ({ ...d, revenue: Number((d.revenue * tasaParaChart).toFixed(2)) }));

    res.json({
      range,
      chart_granularity,
      from: desde.toISOString(),
      to: hasta.toISOString(),
      total_conversations: total_conversations || 0,
      active_conversations: active_conversations || 0,
      messages: messages || 0,
      sales: sales || 0,
      pending: pending || 0,
      currency: monedaSolicitada,
      total_revenue: Number(total_revenue_conv.toFixed(2)),
      avg_ticket: Number(avg_ticket_conv.toFixed(2)),
      conversion_rate: parseFloat(conversion_rate),
      daily_chart: daily_chart_convertido,
      by_weekday: byWeekday
    });
  } catch (err) {
    console.error('[Dashboard error]', err);
    next(err);
  }
});

// ── PATCH /api/conversations/:id/sale ─────────────────────────
router.patch('/:id/sale', async (req, res, next) => {
  try {
    const { is_sale, sale_amount } = req.body;
    const { data, error } = await supabase
      .from('conversations')
      .update({
        is_sale: is_sale ?? true,
        sale_amount: sale_amount || 0,
        sale_at: is_sale ? new Date().toISOString() : null
      })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();
    if (error) throw error;

    // Si se marcó como venta y la conexión es WhatsApp API, avisarle
    // a Meta (Conversions API) para que pueda optimizar los anuncios.
    if (is_sale && data) {
      sendPurchaseEventToMeta(req.user.id, data, sale_amount || 0).catch(() => {});
      // Notificación push: pausada por ahora (ver conversación anterior).
      // Cuando se retome, volver a agregar el require de pushService y
      // descomentar esto.

      // Sistema de recompensas: sumar esta venta al total histórico
      // en dólares del usuario — permanente, no depende de ninguna
      // conexión de WhatsApp ni conversación (aunque se borre el
      // WhatsApp conectado, este número nunca baja, solo suma).
      (async () => {
        try {
          const montoEnDolares = await convertirDesdeSoles(sale_amount || 0, 'USD');
          const { data: userActual } = await supabase.from('users').select('lifetime_revenue_usd').eq('id', req.user.id).single();
          const nuevoTotal = (userActual?.lifetime_revenue_usd || 0) + montoEnDolares;
          await supabase.from('users').update({ lifetime_revenue_usd: nuevoTotal }).eq('id', req.user.id);
        } catch (e) {
          console.error('[Recompensas] Error sumando al total histórico:', e.message);
        }
      })();
    }

    res.json(data);
  } catch (err) { next(err); }
});

// ── PATCH /api/conversations/:id/ai-toggle ─────────────────────
// Prende/apaga el botón "IA" de una conversación específica.
// Cuando está apagado (flow_active = false), el bot se queda en
// silencio y el negocio responde manualmente. Ya funciona así en
// el backend (QR y API) — esta ruta solo expone el interruptor.
router.patch('/:id/ai-toggle', async (req, res, next) => {
  try {
    const raw = req.body.active;
    // Acepta boolean real (true/false), string ("true"/"false", "1"/"0")
    // o número (1/0) — algunos frontends serializan distinto según cómo
    // arman el request, así que no hay que ser estrictos con el tipo,
    // solo con el significado.
    let active;
    if (typeof raw === 'boolean') active = raw;
    else if (typeof raw === 'string') active = raw.toLowerCase() === 'true' || raw === '1';
    else if (typeof raw === 'number') active = raw === 1;
    else active = undefined;

    if (active === undefined) {
      return res.status(400).json({ error: 'El campo "active" (true/false) es requerido' });
    }
    const { data, error } = await supabase
      .from('conversations')
      .update({ flow_active: active })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// ── GET /api/conversations/:id/flows-list ──────────────────────
// Lista los flujos del usuario, para el selector del botón que
// reemplazó al de emojis en el Chat en Vivo.
router.get('/:id/flows-list', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('flows')
      .select('id, name')
      .eq('user_id', req.user.id)
      .order('name', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { next(err); }
});

// ── POST /api/conversations/:id/activate-flow ───────────────────
// Manda un flujo COMPLETO a un cliente manualmente (sin que haya
// escrito ninguna palabra activadora) — usado cuando el negocio
// entra al chat y elige un flujo del selector. Activa el flujo
// (incluyendo sus pausas y seguimientos adjuntos, igual que un
// disparador automático) y prende el botón "IA" de la conversación.
router.post('/:id/activate-flow', async (req, res, next) => {
  try {
    const { flow_id } = req.body;
    if (!flow_id) return res.status(400).json({ error: 'flow_id requerido' });

    const { data: conv } = await supabase
      .from('conversations')
      .select('*, connections(*)')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

    const { data: flow } = await supabase
      .from('flows')
      .select('nodes')
      .eq('id', flow_id)
      .eq('user_id', req.user.id)
      .single();
    if (!flow) return res.status(404).json({ error: 'Flujo no encontrado' });

    const startNode = (flow.nodes || []).find(n => n.type === 'start');
    if (!startNode) return res.status(400).json({ error: 'Ese flujo no tiene un nodo de Inicio configurado' });

    // Prender el botón IA — a partir de ahora el bot sí participa
    // en esta conversación (seguimientos, pausas, todo lo normal).
    await supabase.from('conversations').update({ flow_active: true }).eq('id', conv.id);

    const esCloudAPI = !!(conv.connections?.phone_number_id && conv.connections?.access_token);

    if (esCloudAPI) {
      executeFlow(flow_id, conv.contact_phone, '', conv.connections, conv.id, startNode.id).catch(err => {
        console.error('[Activar flujo manual - Cloud API]', err.message);
      });
    } else {
      const sock = activeSessions[conv.connection_id];
      if (!sock) {
        return res.status(400).json({ error: 'No hay una sesión de WhatsApp QR activa para esta conexión ahora mismo' });
      }
      const jid = conv.last_jid || `${conv.contact_phone}@s.whatsapp.net`;
      executeFlowBaileys(flow_id, sock, jid, conv.contact_phone, '', conv.id, startNode.id).catch(err => {
        console.error('[Activar flujo manual - QR]', err.message);
      });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── GET /api/conversations/dashboard/sales-by-flow ─────────────
// Cuántas ventas (y cuánto ingreso) generó cada flujo — para el
// gráfico de barras "¿Qué flujo vende más?" del Dashboard.
router.get('/dashboard/sales-by-flow', async (req, res, next) => {
  try {
    // 1. Todos los triggers del usuario, con el nombre de su flujo
    const { data: triggers } = await supabase
      .from('triggers')
      .select('id, flow_id, flows(id, name)')
      .eq('user_id', req.user.id);

    if (!triggers?.length) return res.json({ flows: [] });

    const triggerIds = triggers.map(t => t.id);
    const triggerToFlow = {};
    triggers.forEach(t => { triggerToFlow[t.id] = t.flows; });

    // 2. Todas las ejecuciones de esos triggers
    const { data: executions } = await supabase
      .from('trigger_executions')
      .select('trigger_id, conversation_id')
      .in('trigger_id', triggerIds);

    if (!executions?.length) return res.json({ flows: [] });

    // 3. Conversaciones involucradas, para saber cuáles terminaron en venta
    const convIds = [...new Set(executions.map(e => e.conversation_id).filter(Boolean))];
    const { data: convs } = await supabase
      .from('conversations')
      .select('id, is_sale, sale_amount')
      .in('id', convIds);

    const convMap = {};
    (convs || []).forEach(c => { convMap[c.id] = c; });

    // 4. Agrupar por flujo — una conversación cuenta una sola vez por
    // flujo aunque el trigger se haya ejecutado varias veces ahí.
    const porFlujo = {};
    const conversacionesContadasPorFlujo = {};

    for (const exec of executions) {
      const flow = triggerToFlow[exec.trigger_id];
      if (!flow) continue;
      const flowId = flow.id;
      if (!porFlujo[flowId]) {
        porFlujo[flowId] = { flow_id: flowId, flow_name: flow.name || 'Sin nombre', sales: 0, revenue: 0, conversations: 0 };
        conversacionesContadasPorFlujo[flowId] = new Set();
      }
      if (conversacionesContadasPorFlujo[flowId].has(exec.conversation_id)) continue;
      conversacionesContadasPorFlujo[flowId].add(exec.conversation_id);

      porFlujo[flowId].conversations += 1;
      const conv = convMap[exec.conversation_id];
      if (conv?.is_sale) {
        porFlujo[flowId].sales += 1;
        porFlujo[flowId].revenue += parseFloat(conv.sale_amount || 0);
      }
    }

    const flows = Object.values(porFlujo)
      .map(f => ({ ...f, revenue: Number(f.revenue.toFixed(2)) }))
      .sort((a, b) => b.sales - a.sales);

    res.json({ flows });
  } catch (err) { next(err); }
});

// ── GET /api/conversations/dashboard/sales-by-hour ──────────────
// Ventas de HOY agrupadas por hora (0-23), en hora de Perú — para el
// gráfico "ACTIVIDAD CADA 1H". Se reinicia solo cada día, porque
// solo mira las ventas de hoy (no acumula entre días).
router.get('/dashboard/sales-by-hour', async (req, res, next) => {
  try {
    const inicioHoy = inicioDeHoyLima();

    const { data: ventasHoy } = await supabase
      .from('conversations')
      .select('sale_at')
      .eq('user_id', req.user.id)
      .eq('is_sale', true)
      .gte('sale_at', inicioHoy.toISOString());

    // 24 horas en 0, listas para llenar
    const porHora = Array.from({ length: 24 }, (_, h) => ({ hour: h, sales: 0 }));

    for (const v of (ventasHoy || [])) {
      if (!v.sale_at) continue;
      // Convertir la hora UTC guardada a hora de Lima (UTC-5 fijo)
      const ms = new Date(v.sale_at).getTime() - 5 * 60 * 60 * 1000;
      const horaLima = new Date(ms).getUTCHours();
      porHora[horaLima].sales += 1;
    }

    res.json({ hours: porHora });
  } catch (err) { next(err); }
});

// ── GET /api/conversations/rewards ──────────────────────────────
// Sistema de recompensas por dinero generado históricamente (en
// dólares, acumulado para siempre, sin importar si se cambia o
// borra la conexión de WhatsApp).
const NIVELES_RECOMPENSA = [
  { nivel: 1, nombre: 'Novato', min: 0, max: 10000 },
  { nivel: 2, nombre: 'Vendedor Pro', min: 10000, max: 50000 },
  { nivel: 3, nombre: 'Disparador de Elite', min: 50000, max: 100000 },
  { nivel: 4, nombre: 'Leyenda de Ventas', min: 100000, max: 200000 }
];

router.get('/rewards', async (req, res, next) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('lifetime_revenue_usd')
      .eq('id', req.user.id)
      .single();

    const total = user?.lifetime_revenue_usd || 0;

    // Encontrar el nivel actual — el último tramo donde el total ya
    // superó el mínimo (si superó los 200k, se queda en el último
    // nivel, mostrando la barra llena).
    let nivelActual = NIVELES_RECOMPENSA[0];
    for (const n of NIVELES_RECOMPENSA) {
      if (total >= n.min) nivelActual = n;
    }

    const progresoEnNivel = Math.min(total - nivelActual.min, nivelActual.max - nivelActual.min);
    const metaDelNivel = nivelActual.max - nivelActual.min;

    res.json({
      total_usd: Number(total.toFixed(2)),
      nivel: nivelActual.nivel,
      nombre_nivel: nivelActual.nombre,
      progreso_usd: Number(progresoEnNivel.toFixed(2)),
      meta_usd: metaDelNivel,
      nivel_maximo_alcanzado: total >= NIVELES_RECOMPENSA[NIVELES_RECOMPENSA.length - 1].max
    });
  } catch (err) { next(err); }
});

// ── GET /api/conversations/dashboard/ranking-tiendas ────────────
// Métricas por CADA WhatsApp conectado por separado (cada conexión
// es una "tienda") — para la tabla de ranking del Dashboard.
router.get('/dashboard/ranking-tiendas', async (req, res, next) => {
  try {
    const { data: conexiones } = await supabase
      .from('connections')
      .select('id, name, phone_number')
      .eq('user_id', req.user.id);

    if (!conexiones?.length) return res.json({ tiendas: [] });

    const monedaSolicitada = (req.query.currency || 'PEN').toUpperCase();

    const tiendas = await Promise.all(conexiones.map(async (conn) => {
      const [
        { count: contactos },
        { count: mensajes },
        { count: ventas },
        { data: ventasData }
      ] = await Promise.all([
        supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('connection_id', conn.id),
        supabase.from('messages').select('conversations!inner(connection_id)', { count: 'exact', head: true }).eq('conversations.connection_id', conn.id),
        supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('connection_id', conn.id).eq('is_sale', true),
        supabase.from('conversations').select('sale_amount').eq('connection_id', conn.id).eq('is_sale', true)
      ]);

      const facturacionSoles = (ventasData || []).reduce((sum, v) => sum + (v.sale_amount || 0), 0);
      const ticketPromSoles = ventas > 0 ? facturacionSoles / ventas : 0;
      const tasaDeCierre = contactos > 0 ? ((ventas / contactos) * 100) : 0;

      const [facturacion, ticketProm] = await Promise.all([
        convertirDesdeSoles(facturacionSoles, monedaSolicitada),
        convertirDesdeSoles(ticketPromSoles, monedaSolicitada)
      ]);

      return {
        connection_id: conn.id,
        tienda: conn.name || conn.phone_number || 'Sin nombre',
        contactos: contactos || 0,
        mensajes: mensajes || 0,
        ventas: ventas || 0,
        facturacion: Number(facturacion.toFixed(2)),
        ticket_promedio: Number(ticketProm.toFixed(2)),
        tasa_de_cierre: Number(tasaDeCierre.toFixed(1))
      };
    }));

    tiendas.sort((a, b) => b.facturacion - a.facturacion);

    res.json({ currency: monedaSolicitada, tiendas });
  } catch (err) { next(err); }
});

module.exports = router;
