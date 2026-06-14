const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');

router.use(auth);

// ── GET /api/remarketing ─────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('remarketing_config')
      .select('*')
      .eq('user_id', req.user.id)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    res.json(data || {});
  } catch (err) { next(err); }
});

// ── POST /api/remarketing ────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const {
      delay_hours = 0,
      delay_minutes = 30,
      start_time = '09:00',
      end_time = '18:00',
      timezone = 'America/Lima',
      steps = [],
      connection_id
    } = req.body;

    // Upsert — si ya existe lo actualiza, si no lo crea
    const { data: existing } = await supabase
      .from('remarketing_config')
      .select('id')
      .eq('user_id', req.user.id)
      .single();

    let data, error;

    if (existing) {
      ({ data, error } = await supabase
        .from('remarketing_config')
        .update({
          delay_hours,
          delay_minutes,
          start_time,
          end_time,
          timezone,
          steps,
          connection_id,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', req.user.id)
        .select()
        .single());
    } else {
      ({ data, error } = await supabase
        .from('remarketing_config')
        .insert({
          id: uuidv4(),
          user_id: req.user.id,
          delay_hours,
          delay_minutes,
          start_time,
          end_time,
          timezone,
          steps,
          connection_id,
          is_active: true
        })
        .select()
        .single());
    }

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ── PATCH /api/remarketing/toggle ───────────────────────────
router.patch('/toggle', async (req, res, next) => {
  try {
    const { data: existing } = await supabase
      .from('remarketing_config')
      .select('is_active')
      .eq('user_id', req.user.id)
      .single();

    if (!existing) return res.status(404).json({ error: 'No hay configuración de remarketing' });

    const { data, error } = await supabase
      .from('remarketing_config')
      .update({ is_active: !existing.is_active })
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, is_active: data.is_active });
  } catch (err) { next(err); }
});

module.exports = router;
