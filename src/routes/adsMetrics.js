const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const axios = require('axios');
const svc = require('../services/metaProfiles');

router.use(auth);

const GRAPH = svc.GRAPH;

// ── Fechas (hora de Lima) ────────────────────────────────────
const limaToday = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
function addDays(d, n) { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }

// Mismo criterio que Meta: "last_7d/last_30d" NO incluyen el día de hoy.
function rangeFromQuery(q) {
  if (q.from || q.to) return { from: q.from || addDays(limaToday(), -30), to: q.to || limaToday() };
  const today = limaToday();
  switch (q.date_preset) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'last_7d': return { from: addDays(today, -7), to: addDays(today, -1) };
    case 'last_30d': return { from: addDays(today, -30), to: addDays(today, -1) };
    case 'this_month': return { from: today.slice(0, 8) + '01', to: today };
    default: return { from: addDays(today, -30), to: today };
  }
}

// Conversaciones de mensajería iniciadas (dato nativo de Meta).
function getMessagingConversations(actions) {
  if (!Array.isArray(actions)) return 0;
  const a = actions.find(x =>
    x.action_type === 'onsite_conversion.messaging_conversation_started_7d' ||
    x.action_type === 'onsite_conversion.messaging_first_reply');
  return a ? parseInt(a.value || 0) : 0;
}

// Calcula las métricas de UNA cuenta publicitaria. Separado en su
// propia función para poder llamarlo muchas veces en paralelo (ver
// GET /all más abajo) sin repetir código.
async function computeMetricsForAccount(userId, accountId, dateFrom, dateTo) {
  const { ads, statusByAdId } = await svc.withToken(userId, accountId, async token => {
    const r = await axios.get(`${GRAPH}/act_${accountId}/insights`, {
      params: {
        access_token: token,
        time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
        fields: 'ad_id,ad_name,campaign_name,campaign_id,adset_name,spend,impressions,clicks,cpc,cpm,ctr,reach,actions',
        level: 'ad',
        limit: 200
      },
      timeout: 20000
    });
    const adsList = r.data?.data || [];

    // El estado real (activo/pausado) de cada anuncio se trae en
    // paralelo también — antes se pedía de a 50 ids, una tanda
    // detrás de otra; con varias tandas eso suma segundos extra.
    const ids = adsList.map(a => a.ad_id).filter(Boolean);
    const lotes = [];
    for (let i = 0; i < ids.length; i += 50) lotes.push(ids.slice(i, i + 50)); // Meta acepta máx. 50 ids por consulta

    const statuses = {};
    await Promise.all(lotes.map(async lote => {
      try {
        const s = await axios.get(`${GRAPH}/`, {
          params: { ids: lote.join(','), fields: 'effective_status,name', access_token: token },
          timeout: 20000
        });
        for (const id of lote) if (s.data[id]) statuses[id] = s.data[id].effective_status || 'UNKNOWN';
      } catch (e) {
        console.error('[Ads metrics] Error obteniendo estados:', JSON.stringify(e.response?.data || { message: e.message }));
      }
    }));

    return { ads: adsList, statusByAdId: statuses };
  });

  console.log(`[Ads metrics] ${ads.length} anuncios de la cuenta ${accountId} (${dateFrom} → ${dateTo})`);

  const { data: allConversations } = await supabase
    .from('conversations')
    .select('id, ad_id, is_sale, sale_amount, created_at')
    .eq('user_id', userId)
    .gte('created_at', `${dateFrom}T00:00:00.000-05:00`)
    .lte('created_at', `${dateTo}T23:59:59.999-05:00`);
  const conversations = allConversations || [];

  const conversationsByAd = {};
  for (const conv of conversations) {
    if (!conv.ad_id) continue;
    conversationsByAd[conv.ad_id] ??= { count: 0, sales: 0, revenue: 0 };
    conversationsByAd[conv.ad_id].count += 1;
    if (conv.is_sale) {
      conversationsByAd[conv.ad_id].sales += 1;
      conversationsByAd[conv.ad_id].revenue += parseFloat(conv.sale_amount || 0);
    }
  }

  const totalSpend = ads.reduce((s, ad) => s + parseFloat(ad.spend || 0), 0);
  const totalClicks = ads.reduce((s, ad) => s + parseInt(ad.clicks || 0), 0);
  const totalImpressions = ads.reduce((s, ad) => s + parseInt(ad.impressions || 0), 0);
  const totalConversationsFromMeta = ads.reduce((s, ad) => s + getMessagingConversations(ad.actions), 0);
  const totalSales = conversations.filter(c => c.is_sale).length;
  const totalRevenue = conversations.filter(c => c.is_sale).reduce((s, c) => s + parseFloat(c.sale_amount || 0), 0);
  const roi = totalSpend > 0 ? Number((((totalRevenue - totalSpend) / totalSpend) * 100).toFixed(1)) : 0;
  const cpa = totalSales > 0 ? Number((totalSpend / totalSales).toFixed(2)) : 0;

  const adsDetail = ads.map(ad => {
    const stats = conversationsByAd[ad.ad_id] || { sales: 0, revenue: 0 };
    const metaConversations = getMessagingConversations(ad.actions);
    const spend = parseFloat(ad.spend || 0);
    return {
      ad_id: ad.ad_id,
      account_id: accountId,
      name: ad.ad_name || 'Sin nombre',
      campaign: ad.campaign_name || 'Sin campaña',
      campaign_id: ad.campaign_id || null,
      adset: ad.adset_name || null,
      spend: Number(spend.toFixed(2)),
      conversations: metaConversations,
      sales: stats.sales,
      revenue: Number(stats.revenue.toFixed(2)),
      cost_per_conversation: Number((metaConversations > 0 ? spend / metaConversations : 0).toFixed(2)),
      cost_per_sale: Number((stats.sales > 0 ? spend / stats.sales : 0).toFixed(2)),
      roi: Number((spend > 0 ? ((stats.revenue - spend) / spend) * 100 : 0).toFixed(1)),
      clicks: parseInt(ad.clicks || 0),
      impressions: parseInt(ad.impressions || 0),
      reach: parseInt(ad.reach || 0),
      cpc: Number(parseFloat(ad.cpc || 0).toFixed(2)),
      cpm: Number(parseFloat(ad.cpm || 0).toFixed(2)),
      ctr: Number(parseFloat(ad.ctr || 0).toFixed(2)),
      status: (statusByAdId[ad.ad_id] || 'UNKNOWN').toLowerCase(),
      effective_status: statusByAdId[ad.ad_id] || 'UNKNOWN',
      ad_link: ad.ad_id ? `https://www.facebook.com/adsmanager/manage/ads?act=${accountId}&selected_ad_ids=${ad.ad_id}` : null
    };
  });

  return {
    summary: {
      total_spend: Number(totalSpend.toFixed(2)),
      total_conversations: totalConversationsFromMeta,
      total_sales: totalSales,
      total_revenue: Number(totalRevenue.toFixed(2)),
      roi, cpa,
      total_clicks: totalClicks,
      total_impressions: totalImpressions
    },
    ads: adsDetail
  };
}

// ── GET /api/ads-metrics?account_id=&date_preset=  (o from/to) ──
// Una sola cuenta — se mantiene igual que antes, para no romper
// nada que ya funcione.
router.get('/', async (req, res, next) => {
  try {
    const { data: config } = await supabase.from('ads_config').select('ad_account_id').eq('user_id', req.user.id).maybeSingle();
    const accountId = String(req.query.account_id || config?.ad_account_id || '').replace(/^act_/, '');
    if (!accountId) return res.status(400).json({ error: 'Falta account_id (elige una cuenta publicitaria).' });

    const { from: dateFrom, to: dateTo } = rangeFromQuery(req.query);
    const resultado = await computeMetricsForAccount(req.user.id, accountId, dateFrom, dateTo);
    res.json(resultado);
  } catch (err) {
    console.error('[Ads metrics error]', JSON.stringify(err.response?.data || { message: err.message }));
    svc.sendError(res, err, 'No se pudieron cargar las métricas de anuncios');
  }
});

// ── GET /api/ads-metrics/all?date_preset= ────────────────────────
// NUEVO — trae las métricas de TODAS las cuentas publicitarias
// conectadas (de todos los perfiles) en una sola llamada, pidiéndolas
// todas en paralelo en vez de una por una. Esto es lo que hace que
// Campañas cargue mucho más rápido: antes el frontend hacía 6
// peticiones seguidas (una por cuenta); con esta única llamada, las
// 6 se piden al mismo tiempo del lado del servidor.
router.get('/all', async (req, res, next) => {
  try {
    const { from: dateFrom, to: dateTo } = rangeFromQuery(req.query);
    const cuentas = await svc.listAllAccounts(req.user.id);

    const resultados = await Promise.all(cuentas.map(async cuenta => {
      try {
        const data = await computeMetricsForAccount(req.user.id, cuenta.account_id, dateFrom, dateTo);
        return { account_id: cuenta.account_id, account_name: cuenta.name, profile_name: cuenta.profile_name, ...data };
      } catch (err) {
        const mensaje = svc.metaError(err).message;
        console.error(`[Ads metrics] Cuenta ${cuenta.account_id} falló:`, mensaje);
        return { account_id: cuenta.account_id, account_name: cuenta.name, profile_name: cuenta.profile_name, error: mensaje, summary: null, ads: [] };
      }
    }));

    // Totales combinados de todas las cuentas juntas, para la
    // tarjeta-resumen general de arriba de todo en Campañas.
    const ok = resultados.filter(r => r.summary);
    const totales = ok.reduce((acc, r) => ({
      total_spend: acc.total_spend + r.summary.total_spend,
      total_conversations: acc.total_conversations + r.summary.total_conversations,
      total_sales: acc.total_sales + r.summary.total_sales,
      total_revenue: acc.total_revenue + r.summary.total_revenue,
      total_clicks: acc.total_clicks + r.summary.total_clicks,
      total_impressions: acc.total_impressions + r.summary.total_impressions
    }), { total_spend: 0, total_conversations: 0, total_sales: 0, total_revenue: 0, total_clicks: 0, total_impressions: 0 });
    totales.roi = totales.total_spend > 0 ? Number((((totales.total_revenue - totales.total_spend) / totales.total_spend) * 100).toFixed(1)) : 0;
    totales.cpa = totales.total_sales > 0 ? Number((totales.total_spend / totales.total_sales).toFixed(2)) : 0;
    totales.total_spend = Number(totales.total_spend.toFixed(2));
    totales.total_revenue = Number(totales.total_revenue.toFixed(2));

    res.json({ summary: totales, accounts: resultados });
  } catch (err) {
    console.error('[Ads metrics /all error]', JSON.stringify(err.response?.data || { message: err.message }));
    svc.sendError(res, err, 'No se pudieron cargar las métricas de anuncios');
  }
});

module.exports = router;
