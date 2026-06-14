const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');

router.use(auth);

// ── GET /api/payment-config ─────────────────────────────────
// Devuelve config general + reglas
router.get('/', async (req, res, next) => {
  try {
    const { data: config } = await supabase
      .from('payment_config')
      .select('*')
      .eq('user_id', req.user.id)
      .single();

    const { data: rules } = await supabase
      .from('payment_rules')
      .select('*')
      .eq('user_id', req.user.id)
      .order('amount', { ascending: true });

    res.json({
      config: config || {
        msg_confirmacion: 'Gracias por tu pago. Validaremos el comprobante y en breve te enviaremos el acceso.',
        msg_no_valido: 'Disculpa, no pudimos validar el comprobante. Por favor envía una foto más clara.'
      },
      rules: rules || []
    });
  } catch (err) { next(err); }
});

// ── PUT /api/payment-config ─────────────────────────────────
// Guarda mensajes generales
router.put('/', async (req, res, next) => {
  try {
    const { msg_confirmacion, msg_no_valido } = req.body;

    const { data: existing } = await supabase
      .from('payment_config')
      .select('id')
      .eq('user_id', req.user.id)
      .single();

    if (existing) {
      const { data, error } = await supabase
        .from('payment_config')
        .update({
          msg_confirmacion,
          msg_no_valido,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', req.user.id)
        .select()
        .single();
      if (error) throw error;
      return res.json({ success: true, data });
    } else {
      const { data, error } = await supabase
        .from('payment_config')
        .insert({
          id: uuidv4(),
          user_id: req.user.id,
          msg_confirmacion,
          msg_no_valido
        })
        .select()
        .single();
      if (error) throw error;
      return res.json({ success: true, data });
    }
  } catch (err) { next(err); }
});

// ── POST /api/payment-config/rules ──────────────────────────
// Crear nueva regla de acceso
router.post('/rules', async (req, res, next) => {
  try {
    const { amount, context_keywords, access_message } = req.body;

    if (!amount || !access_message) {
      return res.status(400).json({ error: 'Monto y mensaje de acceso son requeridos' });
    }

    const { data, error } = await supabase
      .from('payment_rules')
      .insert({
        id: uuidv4(),
        user_id: req.user.id,
        amount,
        context_keywords: context_keywords || '',
        access_message,
        is_active: true
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// ── PUT /api/payment-config/rules/:id ───────────────────────
router.put('/rules/:id', async (req, res, next) => {
  try {
    const { amount, context_keywords, access_message, is_active } = req.body;
    const updates = {};
    if (amount !== undefined) updates.amount = amount;
    if (context_keywords !== undefined) updates.context_keywords = context_keywords;
    if (access_message !== undefined) updates.access_message = access_message;
    if (is_active !== undefined) updates.is_active = is_active;

    const { data, error } = await supabase
      .from('payment_rules')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// ── DELETE /api/payment-config/rules/:id ────────────────────
router.delete('/rules/:id', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('payment_rules')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
