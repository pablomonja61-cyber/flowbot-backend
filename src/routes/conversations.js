const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const axios = require('axios');
const { sendManualTextBaileys, sendManualMediaBaileys, executeFlowBaileys, activeSessions } = require('../services/baileys');
const {
  sendWhatsAppImage, sendWhatsAppVideo, sendWhatsAppAudio, sendWhatsAppDocument, sendPurchaseEventToMeta, executeFlow
} = require('../services/flowEngine');
const { enviarPushAUsuario } = require('../services/pushService');

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
        last_message_at, unread_count, status, connection_id, tag, profile_pic_url, flow_active,
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
      last_message_at: new Date().toISOString()
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
router.get('/dashboard/stats', async (req, res, next) => {
  try {
    const today = inicioDeHoyLima();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);

    // Antes estas 11 consultas se pedían una por una (await tras await),
    // así que el tiempo total era la SUMA de las 11 — si cada una tarda
    // ~400-500ms, eso son varios segundos de espera. Ninguna depende del
    // resultado de otra, así que se piden todas en paralelo con
    // Promise.all — el tiempo total pasa a ser el de la consulta más
    // lenta, no la suma de todas.
    const [
      { count: total_conversations },
      { count: conversations_today },
      { count: conversations_30d },
      { count: messages_today },
      { count: messages_30d },
      { count: active_conversations },
      { count: sales_total },
      { count: sales_today },
      { count: sales_30d },
      { count: pending_today },
      { count: pending_30d },
      { data: salesData },
      { data: convByDay }
    ] = await Promise.all([
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).gte('created_at', today.toISOString()),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).gte('created_at', thirtyDaysAgo.toISOString()),
      supabase.from('messages').select('conversations!inner(user_id)', { count: 'exact', head: true }).eq('conversations.user_id', req.user.id).gte('created_at', today.toISOString()),
      supabase.from('messages').select('conversations!inner(user_id)', { count: 'exact', head: true }).eq('conversations.user_id', req.user.id).gte('created_at', thirtyDaysAgo.toISOString()),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('status', 'active'),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('is_sale', true),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('is_sale', true).gte('sale_at', today.toISOString()),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('is_sale', true).gte('sale_at', thirtyDaysAgo.toISOString()),
      // "Pendientes" = se le pidió el pago (payment_requested_at) pero
      // todavía no se confirmó la venta (is_sale sigue en false).
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('is_sale', false).not('payment_requested_at', 'is', null).gte('payment_requested_at', today.toISOString()),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('is_sale', false).not('payment_requested_at', 'is', null).gte('payment_requested_at', thirtyDaysAgo.toISOString()),
      supabase.from('conversations').select('sale_amount, sale_at').eq('user_id', req.user.id).eq('is_sale', true),
      supabase.from('conversations').select('created_at').eq('user_id', req.user.id).gte('created_at', thirtyDaysAgo.toISOString()).order('created_at', { ascending: true })
    ]);

    const total_revenue = (salesData || []).reduce((sum, s) => sum + (s.sale_amount || 0), 0);
    const revenue_30d = (salesData || [])
      .filter(s => s.sale_at && new Date(s.sale_at) >= thirtyDaysAgo)
      .reduce((sum, s) => sum + (s.sale_amount || 0), 0);
    const revenue_today = (salesData || [])
      .filter(s => s.sale_at && new Date(s.sale_at) >= today)
      .reduce((sum, s) => sum + (s.sale_amount || 0), 0);
    const avg_ticket = sales_total > 0 ? total_revenue / sales_total : 0;
    const conversion_rate = conversations_30d > 0 ? ((sales_30d / conversations_30d) * 100).toFixed(1) : 0;
    const dailyMap = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date(thirtyDaysAgo);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().split('T')[0];
      dailyMap[key] = { date: key, conversations: 0, sales: 0 };
    }
    (convByDay || []).forEach(c => {
      const key = c.created_at.split('T')[0];
      if (dailyMap[key]) dailyMap[key].conversations++;
    });
    (salesData || []).forEach(s => {
      if (!s.sale_at) return;
      const key = s.sale_at.split('T')[0];
      if (dailyMap[key]) dailyMap[key].sales++;
    });
    const daily_chart = Object.values(dailyMap);
    const weekdays = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const byWeekday = weekdays.map(day => ({ day, sales: 0, conversations: 0 }));
    (convByDay || []).forEach(c => {
      const wd = new Date(c.created_at).getDay();
      byWeekday[wd].conversations++;
    });
    (salesData || []).forEach(s => {
      if (!s.sale_at) return;
      const wd = new Date(s.sale_at).getDay();
      byWeekday[wd].sales++;
    });

    // Todos los montos se calcularon en Soles (PEN) — si el frontend
    // pidió otra moneda (?currency=USD), se convierten de verdad acá,
    // con tasas de cambio reales, antes de responder.
    const monedaSolicitada = (req.query.currency || 'PEN').toUpperCase();
    const [total_revenue_conv, revenue_today_conv, revenue_30d_conv, avg_ticket_conv] = await Promise.all([
      convertirDesdeSoles(total_revenue, monedaSolicitada),
      convertirDesdeSoles(revenue_today, monedaSolicitada),
      convertirDesdeSoles(revenue_30d, monedaSolicitada),
      convertirDesdeSoles(avg_ticket, monedaSolicitada)
    ]);

    res.json({
      total_conversations,
      conversations_today,
      conversations_30d,
      active_conversations,
      messages_today,
      messages_30d,
      sales_total: sales_total || 0,
      sales_today: sales_today || 0,
      sales_30d: sales_30d || 0,
      pending_today: pending_today || 0,
      pending_30d: pending_30d || 0,
      currency: monedaSolicitada,
      total_revenue: Number(total_revenue_conv.toFixed(2)),
      revenue_today: Number(revenue_today_conv.toFixed(2)),
      revenue_30d: Number(revenue_30d_conv.toFixed(2)),
      avg_ticket: Number(avg_ticket_conv.toFixed(2)),
      conversion_rate: parseFloat(conversion_rate),
      daily_chart,
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

      // Notificación push al celular/dispositivos del negocio — "cha-ching"
      const nombreCliente = data.contact_name || data.contact_phone || 'un cliente';
      enviarPushAUsuario(req.user.id, {
        title: '💰 ¡Nueva venta!',
        body: `${nombreCliente} compró por S/${(sale_amount || 0).toFixed(2)}`,
        data: { conversation_id: data.id, type: 'sale' }
      }).catch(() => {});
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

module.exports = router;
