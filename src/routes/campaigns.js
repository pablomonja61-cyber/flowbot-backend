const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const axios = require('axios');

router.use(auth);

const GRAPH_VERSION = 'v26.0';

// ── GET /api/campaigns?ad_account_id=act_123 ─────────────────
// Lista las campañas de la cuenta publicitaria indicada, usando el
// token de Meta Ads que el usuario ya conectó.
router.get('/', async (req, res, next) => {
  try {
    const { ad_account_id } = req.query;
    if (!ad_account_id) {
      return res.status(400).json({ error: 'ad_account_id es requerido' });
    }

    const { data: config } = await supabase
      .from('ads_config')
      .select('access_token')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!config?.access_token) {
      return res.status(404).json({ error: 'No hay una cuenta de Meta Ads conectada todavía' });
    }

    const accountId = ad_account_id.startsWith('act_') ? ad_account_id : `act_${ad_account_id}`;

    const campaignsRes = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${accountId}/campaigns`, {
      params: {
        access_token: config.access_token,
        fields: 'id,name,status,objective,daily_budget,lifetime_budget,created_time'
      }
    });

    res.json(campaignsRes.data?.data || []);
  } catch (err) {
    console.error('[Campaigns] Error listando campañas:', err.response?.data || err.message);
    next(err);
  }
});

module.exports = router;
