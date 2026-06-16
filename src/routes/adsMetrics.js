const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const axios = require('axios');

router.use(auth);

// ── GET /api/ads-metrics ─────────────────────────────────────
router.get('/', async (req, res, next) => {
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

    // 1. Obtener métricas de anuncios desde Meta (incluyendo el ID del anuncio)
    const metricsResponse = await axios.get(
      `https://graph.facebook.com/v19.0/act_${accountId}/insights`,
      {
        params: {
          access_token: config.access_token,
          time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
          fields: 'ad_id,ad_name,campaign_name,campaign_id,adset_name,spend,impressions,clicks,cpc,cpm,reach',
          level: 'ad',
          limit: 50
        },
        timeout: 15000
      }
    );

    const ads = metricsResponse.data.data || [];
    console.log(`[Ads metrics] ${ads.length} anuncios obtenidos de Meta`);

    // 2. Obtener TODAS las conversaciones del usuario en el período,
    //    con su ad_id para poder cruzarlas localmente
    const { data: allConversations } = await supabase
      .from('conversations')
      .select('id, ad_id, is_sale, sale_amount, created_at')
      .eq('user_id', req.user.id)
      .gte('created_at', `${dateFrom}T00:00:00.000Z`)
      .lte('created_at', `${dateTo}T23:59:59.999Z`);

    const conversations = allConversations || [];

    // 3. Agrupar conversaciones por ad_id para cruce rápido
    const conversationsByAd = {};
    for (const conv of conversations) {
      if (!conv.ad_id) continue;
      if (!conversationsByAd[conv.ad_id]) {
        conversationsByAd[conv.ad_id] = { count: 0, sales: 0, revenue: 0 };
      }
      conversationsByAd[conv.ad_id].count += 1;
      if (conv.is_sale) {
        conversationsByAd[conv.ad_id].sales += 1;
        conversationsByAd[conv.ad_id].revenue += parseFloat(conv.sale_amount || 0);
      }
    }

    // 4. Totales generales (resumen de las tarjetas de arriba)
    const totalSpend = ads.reduce((sum, ad) => sum + parseFloat(ad.spend || 0), 0);
    const totalClicks = ads.reduce((sum, ad) => sum + parseInt(ad.clicks || 0), 0);
    const totalImpressions = ads.reduce((sum, ad) => sum + parseInt(ad.impressions || 0), 0);

    const totalConversations = conversations.length;
    const totalSales = conversations.filter(c => c.is_sale).length;
    const totalRevenue = conversations
      .filter(c => c.is_sale)
      .reduce((sum, c) => sum + parseFloat(c.sale_amount || 0), 0);

    const roi = totalSpend > 0 ? (((totalRevenue - totalSpend) / totalSpend) * 100).toFixed(1) : '0.0';
    const cpa = totalSales > 0 ? (totalSpend / totalSales).toFixed(2) : '0.00';

    // 5. Construir la tabla detalle por anuncio, cruzando con conversationsByAd
    const adsDetail = ads.map(ad => {
      const stats = conversationsByAd[ad.ad_id] || { count: 0, sales: 0, revenue: 0 };
      const spend = parseFloat(ad.spend || 0);
      const costPerConv = stats.count > 0 ? (spend / stats.count) : 0;
      const costPerSale = stats.sales > 0 ? (spend / stats.sales) : 0;
      const adRoi = spend > 0 ? (((stats.revenue - spend) / spend) * 100) : 0;

      return {
        ad_id: ad.ad_id,
        name: ad.ad_name || 'Sin nombre',
        campaign: ad.campaign_name || 'Sin campaña',
        spend: spend.toFixed(2),
        conversations: stats.count,
        sales: stats.sales,
        revenue: stats.revenue.toFixed(2),
        cost_per_conversation: costPerConv.toFixed(2),
        cost_per_sale: costPerSale.toFixed(2),
        roi: `${adRoi.toFixed(1)}%`,
        clicks: parseInt(ad.clicks || 0),
        impressions: parseInt(ad.impressions || 0),
        cpc: parseFloat(ad.cpc || 0).toFixed(2),
        status: 'active'
      };
    });

    res.json({
      summary: {
        total_spend: totalSpend.toFixed(2),
        total_conversations: totalConversations,
        total_sales: totalSales,
        total_revenue: totalRevenue.toFixed(2),
        roi: `${roi}%`,
        cpa: cpa,
        total_clicks: totalClicks,
        total_impressions: totalImpressions
      },
      ads: adsDetail
    });
  } catch (err) {
    console.error('[Ads metrics error]', err.response?.data || err.message);
    next(err);
  }
});

module.exports = router;