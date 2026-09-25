const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');

router.use(auth);

router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('country_blocks')
      .select('is_enabled, country_codes')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    res.json({ enabled: data?.is_enabled || false, blocked: data?.country_codes || [] });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { enabled, blocked } = req.body;
    const { data: existing } = await supabase
      .from('country_blocks')
      .select('id')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from('country_blocks')
        .update({ is_enabled: !!enabled, country_codes: blocked || [], updated_at: new Date().toISOString() })
        .eq('user_id', req.user.id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('country_blocks')
        .insert({ user_id: req.user.id, is_enabled: !!enabled, country_codes: blocked || [] });
      if (error) throw error;
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
