const express = require('express');
const router = express.Router();
const supabase = require('../models/supabase');
const axios = require('axios');

// ── Middleware de autenticación simple para uso personal ─────
// Usa una API key fija desde variable de entorno
router.use((req, res, next) => {
  const key = req.headers['x-analytics-key'] || req.query.key;
  if (key !== process.env.ANALYTICS_SECRET_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
});

// ════════════════════════════════════════════════════════════
// GET /api/analytics/summary
// Resumen general: ingresos, ventas, conversaciones por cuenta
// ════════════════════════════════════════════════════════════
router.get('/summary', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const dateFrom = from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const dateTo = to || new Date().toISOString().split('T')[0];

    // Todas las conversaciones en el período
    const { data: conversations } = await supabase
      .from('conversations')
      .select('id, user_id, is_sale, sale_amount, sale_at, created_at')
      .gte('created_at', `${dateFrom}T00:00:00.000Z`)
      .lte('created_at', `${dateTo}T23:59:59.999Z`);

    const convs = conversations || [];

    // Agrupar por user_id para ver por cuenta
    const byAccount = {};
    for (const c of convs) {
      if (!byAccount[c.user_id]) {
        byAccount[c.user_id] = { conversations: 0, sales: 0, revenue: 0 };
      }
      byAccount[c.user_id].conversations += 1;
      if (c.is_sale) {
        byAccount[c.user_id].sales += 1;
        byAccount[c.user_id].revenue += parseFloat(c.sale_amount || 0);
      }
    }

    // Obtener nombres de usuarios
    const { data: users } = await supabase
      .from('users')
      .select('id, email, name');

    const userMap = {};
    (users || []).forEach(u => { userMap[u.id] = u.name || u.email; });

    // Totales globales
    const totalConversations = convs.length;
    const totalSales = convs.filter(c => c.is_sale).length;
    const totalRevenue = convs
      .filter(c => c.is_sale)
      .reduce((sum, c) => sum + parseFloat(c.sale_amount || 0), 0);
    const conversionRate = totalConversations > 0
      ? ((totalSales / totalConversations) * 100).toFixed(1)
      : 0;

    // Ventas por día para gráfica de línea
    const salesByDay = {};
    const convsByDay = {};
    for (const c of convs) {
      const day = c.created_at.split('T')[0];
      convsByDay[day] = (convsByDay[day] || 0) + 1;
      if (c.is_sale) {
        salesByDay[day] = (salesByDay[day] || 0) + 1;
      }
    }

    // Generar array de días para el rango
    const days = [];
    const start = new Date(dateFrom);
    const end = new Date(dateTo);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const day = d.toISOString().split('T')[0];
      days.push({
        date: day,
        conversations: convsByDay[day] || 0,
        sales: salesByDay[day] || 0
      });
    }

    res.json({
      summary: {
        total_conversations: totalConversations,
        total_sales: totalSales,
        total_revenue: Number(totalRevenue.toFixed(2)),
        conversion_rate: Number(conversionRate),
        avg_ticket: totalSales > 0
          ? Number((totalRevenue / totalSales).toFixed(2))
          : 0
      },
      by_account: Object.entries(byAccount).map(([userId, stats]) => ({
        user_id: userId,
        name: userMap[userId] || userId,
        ...stats,
        revenue: Number(stats.revenue.toFixed(2)),
        conversion_rate: stats.conversations > 0
          ? Number(((stats.sales / stats.conversations) * 100).toFixed(1))
          : 0
      })),
      chart: days
    });
  } catch (err) {
    console.error('[Analytics summary error]', err.message);
    next(err);
  }
});

// ════════════════════════════════════════════════════════════
// GET /api/analytics/flows
// Qué flujos generan más ventas
// ════════════════════════════════════════════════════════════
router.get('/flows', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const dateFrom = from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const dateTo = to || new Date().toISOString().split('T')[0];

    // Obtener todas las ejecuciones de triggers en el período
    const { data: executions } = await supabase
      .from('trigger_executions')
      .select('trigger_id, conversation_id, executed_at')
      .gte('executed_at', `${dateFrom}T00:00:00.000Z`)
      .lte('executed_at', `${dateTo}T23:59:59.999Z`);

    if (!executions?.length) {
      return res.json({ flows: [] });
    }

    // Obtener conversaciones que resultaron en venta
    const convIds = [...new Set(executions.map(e => e.conversation_id))];
    const { data: convs } = await supabase
      .from('conversations')
      .select('id, is_sale, sale_amount')
      .in('id', convIds);

    const convMap = {};
    (convs || []).forEach(c => { convMap[c.id] = c; });

    // Obtener triggers y sus flujos
    const triggerIds = [...new Set(executions.map(e => e.trigger_id))];
    const { data: triggers } = await supabase
      .from('triggers')
      .select('id, name, flow_id, flows(name)')
      .in('id', triggerIds);

    const triggerMap = {};
    (triggers || []).forEach(t => { triggerMap[t.id] = t; });

    // Agrupar por trigger
    const byTrigger = {};
    for (const exec of executions) {
      const tid = exec.trigger_id;
      if (!byTrigger[tid]) {
        byTrigger[tid] = { executions: 0, sales: 0, revenue: 0 };
      }
      byTrigger[tid].executions += 1;
      const conv = convMap[exec.conversation_id];
      if (conv?.is_sale) {
        byTrigger[tid].sales += 1;
        byTrigger[tid].revenue += parseFloat(conv.sale_amount || 0);
      }
    }

    const flows = Object.entries(byTrigger)
      .map(([triggerId, stats]) => {
        const trigger = triggerMap[triggerId];
        return {
          trigger_id: triggerId,
          trigger_name: trigger?.name || 'Sin nombre',
          flow_name: trigger?.flows?.name || 'Sin flujo',
          executions: stats.executions,
          sales: stats.sales,
          revenue: Number(stats.revenue.toFixed(2)),
          conversion_rate: stats.executions > 0
            ? Number(((stats.sales / stats.executions) * 100).toFixed(1))
            : 0
        };
      })
      .sort((a, b) => b.sales - a.sales);

    res.json({ flows });
  } catch (err) {
    console.error('[Analytics flows error]', err.message);
    next(err);
  }
});

// ════════════════════════════════════════════════════════════
// GET /api/analytics/ads
// Anuncios con demografía (edad/sexo) desde Meta Ads API
// ════════════════════════════════════════════════════════════
router.get('/ads', async (req, res, next) => {
  try {
    const { from, to, user_id } = req.query;
    const dateFrom = from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const dateTo = to || new Date().toISOString().split('T')[0];

    // Obtener config de Meta Ads (si user_id especificado, solo esa cuenta)
    let configQuery = supabase.from('ads_config').select('*');
    if (user_id) configQuery = configQuery.eq('user_id', user_id);
    const { data: configs } = await configQuery;

    if (!configs?.length) {
      return res.json({ ads: [], demographics: { age: [], gender: [] } });
    }

    const allAds = [];
    const ageMap = {};
    const genderMap = {};

    for (const config of configs) {
      const accountId = config.ad_account_id.replace('act_', '');

      try {
        // Métricas por anuncio con breakdown de edad y sexo
        const [adsRes, ageRes, genderRes] = await Promise.all([
          // Anuncios con métricas básicas
          axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/insights`, {
            params: {
              access_token: config.access_token,
              time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
              fields: 'ad_id,ad_name,campaign_name,spend,impressions,clicks,actions',
              level: 'ad',
              limit: 20
            },
            timeout: 15000
          }),
          // Breakdown por edad
          axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/insights`, {
            params: {
              access_token: config.access_token,
              time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
              fields: 'spend,impressions,clicks,actions',
              breakdowns: 'age',
              limit: 20
            },
            timeout: 15000
          }),
          // Breakdown por género
          axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/insights`, {
            params: {
              access_token: config.access_token,
              time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
              fields: 'spend,impressions,clicks,actions',
              breakdowns: 'gender',
              limit: 10
            },
            timeout: 15000
          })
        ]);

        // Procesar anuncios
        for (const ad of adsRes.data.data || []) {
          const purchases = (ad.actions || []).find(a =>
            a.action_type === 'onsite_conversion.messaging_conversation_started_7d'
          );

          // Obtener preview del anuncio
          let previewUrl = null;
          try {
            const creativeRes = await axios.get(
              `https://graph.facebook.com/v19.0/${ad.ad_id}`,
              {
                params: {
                  fields: 'creative{thumbnail_url,image_url,video_id}',
                  access_token: config.access_token
                },
                timeout: 5000
              }
            );
            previewUrl = creativeRes.data?.creative?.thumbnail_url ||
              creativeRes.data?.creative?.image_url || null;
          } catch (e) {
            // Sin preview, no es crítico
          }

          allAds.push({
            ad_id: ad.ad_id,
            name: ad.ad_name || 'Sin nombre',
            campaign: ad.campaign_name || '',
            spend: Number(parseFloat(ad.spend || 0).toFixed(2)),
            impressions: parseInt(ad.impressions || 0),
            clicks: parseInt(ad.clicks || 0),
            conversations: purchases ? parseInt(purchases.value || 0) : 0,
            preview_url: previewUrl,
            account_id: accountId
          });
        }

        // Acumular demografía por edad
        for (const row of ageRes.data.data || []) {
          const age = row.age || 'Desconocido';
          if (!ageMap[age]) ageMap[age] = { clicks: 0, spend: 0 };
          ageMap[age].clicks += parseInt(row.clicks || 0);
          ageMap[age].spend += parseFloat(row.spend || 0);
        }

        // Acumular demografía por género
        for (const row of genderRes.data.data || []) {
          const gender = row.gender === 'male' ? 'Hombre'
            : row.gender === 'female' ? 'Mujer' : 'Desconocido';
          if (!genderMap[gender]) genderMap[gender] = { clicks: 0, spend: 0 };
          genderMap[gender].clicks += parseInt(row.clicks || 0);
          genderMap[gender].spend += parseFloat(row.spend || 0);
        }

      } catch (metaErr) {
        console.error(`[Analytics ads] Error con cuenta ${accountId}:`, metaErr.response?.data || metaErr.message);
      }
    }

    // Cruzar ventas reales de AriaBot por ad_id
    const { data: salesConvs } = await supabase
      .from('conversations')
      .select('ad_id, sale_amount, is_sale')
      .eq('is_sale', true)
      .gte('sale_at', `${dateFrom}T00:00:00.000Z`)
      .lte('sale_at', `${dateTo}T23:59:59.999Z`);

    const salesByAd = {};
    for (const c of salesConvs || []) {
      if (!c.ad_id) continue;
      if (!salesByAd[c.ad_id]) salesByAd[c.ad_id] = { sales: 0, revenue: 0 };
      salesByAd[c.ad_id].sales += 1;
      salesByAd[c.ad_id].revenue += parseFloat(c.sale_amount || 0);
    }

    // Enriquecer anuncios con ventas reales
    const enrichedAds = allAds.map(ad => {
      const sales = salesByAd[ad.ad_id] || { sales: 0, revenue: 0 };
      return {
        ...ad,
        sales: sales.sales,
        revenue: Number(sales.revenue.toFixed(2)),
        cpa: sales.sales > 0 ? Number((ad.spend / sales.sales).toFixed(2)) : 0,
        roi: ad.spend > 0
          ? Number((((sales.revenue - ad.spend) / ad.spend) * 100).toFixed(1))
          : 0
      };
    }).sort((a, b) => b.revenue - a.revenue);

    res.json({
      ads: enrichedAds,
      demographics: {
        age: Object.entries(ageMap)
          .map(([age, stats]) => ({
            age,
            clicks: stats.clicks,
            spend: Number(stats.spend.toFixed(2))
          }))
          .sort((a, b) => b.clicks - a.clicks),
        gender: Object.entries(genderMap)
          .map(([gender, stats]) => ({
            gender,
            clicks: stats.clicks,
            spend: Number(stats.spend.toFixed(2))
          }))
      }
    });
  } catch (err) {
    console.error('[Analytics ads error]', err.message);
    next(err);
  }
});

module.exports = router;
