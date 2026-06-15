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

// ── GET /api/ads-config/metrics ──────────────────────────────
router.get('/metrics', async (req, res, next) => {
  try {
    const { from, to } = req.query;

    const { data: config } = await supabase
      .from('ads_config')
      .select('*')
      .eq('user_id', req.user.id)
      .single();

    if (!config) return res.status(404).json({ error: 'No hay configuración de Meta Ads' });

    const accountId = config.ad_account_id.replace('act_', '');
    const dateFrom = from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const dateTo = to || new Date().toISOString().split('T')[0];

    // Obtener métricas de campañas
    const metricsResponse = await axios.get(
      `https://graph.facebook.com/v19.0/act_${accountId}/insights`,
      {
        params: {
          access_token: config.access_token,
          time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
          fields: 'campaign_name,adset_name,ad_name,spend,impressions,clicks,cpc,cpm,reach',
          level: 'ad',
          limit: 50
        },
        timeout: 15000
      }
    );

    const ads = metricsResponse.data.data || [];

    // Calcular totales
    const totalSpend = ads.reduce((sum, ad) => sum + parseFloat(ad.spend || 0), 0);
    const totalClicks = ads.reduce((sum, ad) => sum + parseInt(ad.clicks || 0), 0);
    const totalImpressions = ads.reduce((sum, ad) => sum + parseInt(ad.impressions || 0), 0);

    // Obtener ventas del período desde Supabase
    const { count: totalSales } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('is_sale', true)
      .gte('sale_at', `${dateFrom}T00:00:00.000Z`)
      .lte('sale_at', `${dateTo}T23:59:59.999Z`);

    const { data: salesData } = await supabase
      .from('conversations')
      .select('sale_amount')
      .eq('user_id', req.user.id)
      .eq('is_sale', true)
      .gte('sale_at', `${dateFrom}T00:00:00.000Z`)
      .lte('sale_at', `${dateTo}T23:59:59.999Z`);

    const totalRevenue = (salesData || []).reduce((sum, s) => sum + parseFloat(s.sale_amount || 0), 0);
    const roi = totalSpend > 0 ? (((totalRevenue - totalSpend) / totalSpend) * 100).toFixed(1) : 0;

    // Obtener conversaciones del período
    const { count: totalConversations } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .gte('created_at', `${dateFrom}T00:00:00.000Z`)
      .lte('created_at', `${dateTo}T23:59:59.999Z`);

    res.json({
      summary: {
        total_spend: totalSpend.toFixed(2),
        total_conversations: totalConversations || 0,
        total_sales: totalSales || 0,
        total_revenue: totalRevenue.toFixed(2),
        roi: `${roi}%`,
        total_clicks: totalClicks,
        total_impressions: totalImpressions
      },
      ads: ads.map(ad => ({
        name: ad.ad_name || 'Sin nombre',
        campaign: ad.campaign_name || '',
        spend: parseFloat(ad.spend || 0).toFixed(2),
        clicks: parseInt(ad.clicks || 0),
        impressions: parseInt(ad.impressions || 0),
        cpc: parseFloat(ad.cpc || 0).toFixed(2),
        status: 'active'
      }))
    });
  } catch (err) {
    console.error('[Ads metrics error]', err.response?.data || err.message);
    next(err);
  }
});

module.exports = router;
