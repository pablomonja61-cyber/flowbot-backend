const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const axios = require('axios');

router.use(auth);

// ── GET /api/ads-config ──────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('ads_config')
      .select('id, ad_account_id, pixel_id, currency, conversions_api, created_at')
      .eq('user_id', req.user.id)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    res.json(data || {});
  } catch (err) { next(err); }
});

// ── POST /api/ads-config ─────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { ad_account_id, access_token, pixel_id, currency, conversions_api } = req.body;
    if (!ad_account_id || !access_token) {
      return res.status(400).json({ error: 'Ad Account ID y Access Token son requeridos' });
    }
    // Verificar token con Meta
    try {
      await axios.get(
        `https://graph.facebook.com/v19.0/act_${ad_account_id.replace('act_', '')}`,
        {
          params: { fields: 'id,name', access_token },
          timeout: 10000
        }
      );
    } catch (e) {
      return res.status(400).json({ error: 'Token o Ad Account ID inválido. Verifica tus credenciales de Meta.' });
    }
    // Upsert config
    const { data: existing } = await supabase
      .from('ads_config')
      .select('id')
      .eq('user_id', req.user.id)
      .single();
    let result;
    if (existing) {
      const { data, error } = await supabase
        .from('ads_config')
        .update({ ad_account_id, access_token, pixel_id, currency, conversions_api, updated_at: new Date().toISOString() })
        .eq('user_id', req.user.id)
        .select()
        .single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await supabase
        .from('ads_config')
        .insert({ user_id: req.user.id, ad_account_id, access_token, pixel_id, currency, conversions_api })
        .select()
        .single();
      if (error) throw error;
      result = data;
    }
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// ── DELETE /api/ads-config ───────────────────────────────────
router.delete('/', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('ads_config')
      .delete()
      .eq('user_id', req.user.id);

    if (error) throw error;

    console.log(`[Ads config] Configuración eliminada para user: ${req.user.id}`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;