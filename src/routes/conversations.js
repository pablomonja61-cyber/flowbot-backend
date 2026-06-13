const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { sendWhatsAppMessage } = require('../services/flowEngine');
const { v4: uuidv4 } = require('uuid');

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
    await supabase
      .from('conversations')
      .update({ unread_count: 0 })
      .eq('id', req.params.id);
    res.json(data);
  } catch (err) { next(err); }
});

// ── POST /api/conversations/:id/messages ─────────────────────
router.post('/:id/messages', async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content es requerido' });

    // Verificar que la conversación es del usuario
    const { data: conv } = await supabase
      .from('conversations')
      .select('*, connections(*)')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

    // Enviar mensaje por WhatsApp
    await sendWhatsAppMessage(
      conv.connections.phone_number_id,
      conv.connections.access_token,
      conv.contact_phone,
      content
    );

    // Guardar en DB
    const { data: msg } = await supabase.from('messages').insert({
      id: uuidv4(),
      conversation_id: conv.id,
      content,
      direction: 'outbound',
      created_at: new Date().toISOString()
    }).select().single();

    // Actualizar último mensaje
    await supabase.from('conversations').update({
      last_message: content.slice(0, 100),
      last_message_at: new Date().toISOString()
    }).eq('id', conv.id);

    res.json(msg);
  } catch (err) { next(err); }
});

// ── GET /api/conversations/stats ──────────────────────────────
router.get('/stats/summary', async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [{ count: total }, { count: today_count }, { count: active }] = await Promise.all([
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).gte('created_at', today.toISOString()),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('status', 'active')
    ]);
    const { count: msgs_today } = await supabase
      .from('messages')
      .select('conversations!inner(user_id)', { count: 'exact', head: true })
      .eq('conversations.user_id', req.user.id)
      .gte('created_at', today.toISOString());
    res.json({ total, today: today_count, active, messages_today: msgs_today });
  } catch (err) { next(err); }
});

module.exports = router;