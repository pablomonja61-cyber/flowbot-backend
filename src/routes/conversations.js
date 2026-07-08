const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');

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
        last_message_at, unread_count, status, connection_id,
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
    const { content, direction = 'outbound' } = req.body;
    if (!content) return res.status(400).json({ error: 'content requerido' });

    const { data: conv } = await supabase
      .from('conversations')
      .select('*, connections(*)')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

    // Enviar por WhatsApp si es outbound
    // IMPORTANTE: antes esto siempre intentaba mandar por la API oficial
    // de Meta sin importar el tipo de conexión. Si la conexión era QR,
    // la petición a Meta fallaba, el error se tragaba en el catch, y el
    // mensaje se guardaba igual en la base de datos como si se hubiera
    // enviado — por eso se veía en el Chat en Vivo pero nunca llegaba
    // de verdad al WhatsApp del cliente. Ahora se revisa el tipo real
    // de conexión, y si el envío falla, se corta y se avisa el error
    // en vez de guardar el mensaje como si hubiese llegado.
    if (direction === 'outbound' && conv.connections) {
      const connType = conv.connections.connection_type;

      if (connType === 'qr') {
        try {
          const { sendManualText } = require('../services/baileys');
          await sendManualText(conv.connections.id, conv.contact_phone, content);
        } catch (e) {
          console.error('[Manual send QR error]', e.message);
          return res.status(502).json({ error: 'No se pudo enviar el mensaje por WhatsApp QR: ' + e.message });
        }
      } else {
        const axios = require('axios');
        try {
          await axios.post(
            `https://graph.facebook.com/v19.0/${conv.connections.phone_number_id}/messages`,
            {
              messaging_product: 'whatsapp',
              to: conv.contact_phone,
              type: 'text',
              text: { body: content }
            },
            { headers: { Authorization: `Bearer ${conv.connections.access_token}`, 'Content-Type': 'application/json' } }
          );
        } catch (e) {
          console.error('[Manual send API error]', e.response?.data || e.message);
          return res.status(502).json({ error: 'No se pudo enviar el mensaje por WhatsApp API: ' + (e.response?.data?.error?.message || e.message) });
        }
      }
    }

    const { data: msg, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: req.params.id,
        content,
        direction,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    await supabase.from('conversations').update({
      last_message: content.slice(0, 100),
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

    await supabase.from('conversations').update({ unread_count: 0 }).eq('id', req.params.id);
    res.json(data);
  } catch (err) { next(err); }
});

// ── GET /api/conversations/stats/summary ─────────────────────
router.get('/stats/summary', async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

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
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    // Conversaciones totales
    const { count: total_conversations } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id);

    // Conversaciones hoy
    const { count: conversations_today } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .gte('created_at', today.toISOString());

    // Conversaciones últimos 30 días
    const { count: conversations_30d } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .gte('created_at', thirtyDaysAgo.toISOString());

    // Mensajes totales de hoy
    const { count: messages_today } = await supabase
      .from('messages')
      .select('conversations!inner(user_id)', { count: 'exact', head: true })
      .eq('conversations.user_id', req.user.id)
      .gte('created_at', today.toISOString());

    // Mensajes últimos 30 días
    const { count: messages_30d } = await supabase
      .from('messages')
      .select('conversations!inner(user_id)', { count: 'exact', head: true })
      .eq('conversations.user_id', req.user.id)
      .gte('created_at', thirtyDaysAgo.toISOString());

    // Conversaciones activas
    const { count: active_conversations } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('status', 'active');

    // Ventas (conversaciones marcadas como sale=true)
    const { count: sales_total } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('is_sale', true);

    const { count: sales_today } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('is_sale', true)
      .gte('sale_at', today.toISOString());

    const { count: sales_30d } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('is_sale', true)
      .gte('sale_at', thirtyDaysAgo.toISOString());

    // Ingresos
    const { data: salesData } = await supabase
      .from('conversations')
      .select('sale_amount, sale_at')
      .eq('user_id', req.user.id)
      .eq('is_sale', true);

    const total_revenue = (salesData || []).reduce((sum, s) => sum + (s.sale_amount || 0), 0);
    const revenue_30d = (salesData || [])
      .filter(s => s.sale_at && new Date(s.sale_at) >= thirtyDaysAgo)
      .reduce((sum, s) => sum + (s.sale_amount || 0), 0);
    const revenue_today = (salesData || [])
      .filter(s => s.sale_at && new Date(s.sale_at) >= today)
      .reduce((sum, s) => sum + (s.sale_amount || 0), 0);

    const avg_ticket = sales_total > 0 ? total_revenue / sales_total : 0;
    const conversion_rate = conversations_30d > 0 ? ((sales_30d / conversations_30d) * 100).toFixed(1) : 0;

    // Gráfica: conversaciones por día últimos 30 días
    const { data: convByDay } = await supabase
      .from('conversations')
      .select('created_at')
      .eq('user_id', req.user.id)
      .gte('created_at', thirtyDaysAgo.toISOString())
      .order('created_at', { ascending: true });

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

    // Ventas por día de la semana
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

    res.json({
      // Métricas principales
      total_conversations,
      conversations_today,
      conversations_30d,
      active_conversations,
      messages_today,
      messages_30d,

      // Ventas
      sales_total: sales_total || 0,
      sales_today: sales_today || 0,
      sales_30d: sales_30d || 0,

      // Ingresos
      total_revenue,
      revenue_today,
      revenue_30d,
      avg_ticket,
      conversion_rate: parseFloat(conversion_rate),

      // Gráficas
      daily_chart,
      by_weekday: byWeekday
    });
  } catch (err) {
    console.error('[Dashboard error]', err);
    next(err);
  }
});

// ── PATCH /api/conversations/:id/sale ─────────────────────────
// Marcar conversación como venta
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
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
