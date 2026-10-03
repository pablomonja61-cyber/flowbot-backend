const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const axios = require('axios');
const svc = require('../services/metaProfiles');

router.use(auth);

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const GRAPH_VERSION = 'v26.0';

// ── Conversión de moneda (mismo criterio que Dashboard/ads-metrics) ──
let cacheTasasCambio = { rates: null, fetchedAt: 0 };
const UNA_HORA_MS = 60 * 60 * 1000;
async function obtenerTasasCambio() {
  const ahora = Date.now();
  if (cacheTasasCambio.rates && (ahora - cacheTasasCambio.fetchedAt) < UNA_HORA_MS) return cacheTasasCambio.rates;
  try {
    const { data } = await axios.get('https://open.er-api.com/v6/latest/PEN', { timeout: 8000 });
    if (data?.result === 'success' && data.rates) {
      cacheTasasCambio = { rates: data.rates, fetchedAt: ahora };
      return data.rates;
    }
  } catch (e) {
    console.error('[Meta Ads] Error obteniendo tasas de cambio:', e.message);
  }
  return cacheTasasCambio.rates || null;
}
async function convertirMoneda(monto, monedaOrigen, monedaDestino) {
  if (!monto || monedaOrigen === monedaDestino) return monto;
  const rates = await obtenerTasasCambio();
  if (!rates) return monto;
  const enSoles = monedaOrigen && monedaOrigen !== 'PEN' ? (rates[monedaOrigen] ? monto / rates[monedaOrigen] : monto) : monto;
  if (!monedaDestino || monedaDestino === 'PEN') return enSoles;
  return rates[monedaDestino] ? enSoles * rates[monedaDestino] : enSoles;
}
async function monedaDeCuenta(userId, accountId) {
  const cuentas = await svc.listAllAccounts(userId);
  return cuentas.find(c => c.account_id === String(accountId).replace(/^act_/, ''))?.currency || 'PEN';
}

// Fijo en el código a propósito — Meta exige que el redirect_uri sea
// IDÉNTICO, byte por byte, entre el paso de autorización y el de
// intercambio del código. Dejarlo fijo acá evita cualquier diferencia
// (como una barra "/" de más) entre esos 2 pasos.
const META_ADS_REDIRECT_URI = 'https://ariabot.app/meta/callback';

// ── GET /api/meta/connect ────────────────────────────────────
// Devuelve la URL de autorización de Meta para pedir permisos de
// Ads (ads_read, ads_management) — distinto del login de WhatsApp,
// este es para conectar la cuenta publicitaria.
router.get('/connect', async (req, res, next) => {
  try {
    if (!META_APP_ID) {
      return res.status(500).json({ error: 'META_APP_ID no configurado en el servidor' });
    }
    const params = new URLSearchParams({
      client_id: META_APP_ID,
      redirect_uri: META_ADS_REDIRECT_URI,
      scope: 'ads_read,ads_management,business_management',
      response_type: 'code',
      state: req.user.id
    });
    res.json({ url: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}` });
  } catch (err) { next(err); }
});

// ── POST /api/meta/callback ──────────────────────────────────
// Recibe el "code" que Meta devuelve después de autorizar permisos
// de Ads, lo cambia por un access_token, y lo guarda.
router.post('/callback', async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'code es requerido' });
    if (!META_APP_ID || !META_APP_SECRET) {
      return res.status(500).json({ error: 'META_APP_ID / META_APP_SECRET no configurados en el servidor' });
    }

    const tokenRes = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`, {
      params: {
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        redirect_uri: META_ADS_REDIRECT_URI,
        code
      }
    });

    const accessToken = tokenRes.data?.access_token;
    if (!accessToken) {
      return res.status(400).json({ error: 'Meta no devolvió un token de acceso válido' });
    }

    // Cambiar por un token de larga duración (dura ~60 días en vez de
    // horas) — sin esto, la conexión se cae sola muy rápido.
    let finalToken = accessToken;
    try {
      const longLivedRes = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`, {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: META_APP_ID,
          client_secret: META_APP_SECRET,
          fb_exchange_token: accessToken
        }
      });
      finalToken = longLivedRes.data?.access_token || accessToken;
    } catch (e) {
      console.warn('[Meta Ads] No se pudo extender el token, se usa el corto:', e.response?.data || e.message);
    }

    // Guardar/actualizar en ads_config (mismo lugar que ya usa el
    // Pixel, para que todo Meta Ads viva en un solo lugar)
    const { data: existing } = await supabase
      .from('ads_config')
      .select('id')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (existing) {
      await supabase.from('ads_config').update({
        access_token: finalToken, updated_at: new Date().toISOString()
      }).eq('user_id', req.user.id);
    } else {
      await supabase.from('ads_config').insert({
        user_id: req.user.id, access_token: finalToken
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Meta Ads] Error en callback:', err.response?.data || err.message);
    res.status(400).json({ error: 'No se pudo conectar tu cuenta de Meta Ads. Intenta de nuevo.' });
  }
});

// ── Utilidades para métricas ─────────────────────────────────
const PRESETS = new Set(['today', 'yesterday', 'last_7d', 'last_30d', 'this_month', 'last_month', 'maximum']);
const presetOf = v => (PRESETS.has(v) ? v : 'last_30d');
const INSIGHT_FIELDS = 'spend,impressions,clicks,reach,ctr,cpm,cpc,actions';

// Aplana el bloque "insights" anidado que devuelve Meta.
function flatInsights(node) {
  const i = node.insights?.data?.[0] || {};
  const conv = (i.actions || []).find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d');
  return {
    spend: i.spend || '0', impressions: i.impressions || '0', clicks: i.clicks || '0',
    reach: i.reach || '0', ctr: i.ctr || '0', cpm: i.cpm || '0', cpc: i.cpc || '0',
    conversations: conv ? parseInt(conv.value || 0) : 0
  };
}

const actId = id => (String(id).startsWith('act_') ? String(id) : `act_${id}`);

// ── GET /api/meta/adaccounts ──────────────────────────────────
// Cuentas publicitarias de TODOS los perfiles conectados del usuario
// (más las del OAuth anterior, si existieran). Si no hay ninguna
// devuelve lista vacía — no es un error, solo falta conectar.
router.get('/adaccounts', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const accounts = await svc.listAllAccounts(req.user.id);

    const legacy = await svc.legacyToken(req.user.id);
    if (legacy) {
      try {
        const r = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/me/adaccounts`, {
          params: { access_token: legacy, fields: 'id,name,account_status,currency', limit: 100 }
        });
        const known = new Set(accounts.map(a => a.account_id));
        for (const a of (r.data?.data || [])) {
          const plain = String(a.id).replace(/^act_/, '');
          if (known.has(plain)) continue;
          accounts.push({ ...a, account_id: plain, profile_id: null, profile_name: 'Conexión anterior (Facebook)', profile_status: 'active' });
        }
      } catch (e) {
        console.warn('[Meta Ads] El token del OAuth anterior ya no sirve:', e.response?.data?.error?.message || e.message);
      }
    }

    accounts.sort((a, b) => String(a.profile_name || '').localeCompare(String(b.profile_name || '')) || String(a.name || '').localeCompare(String(b.name || '')));
    res.json(accounts);
  } catch (err) { next(err); }
});

// ── GET /api/meta/pixels?ad_account_id=act_123 ────────────────
router.get('/pixels', async (req, res, next) => {
  try {
    const { ad_account_id } = req.query;
    if (!ad_account_id) return res.status(400).json({ error: 'ad_account_id es requerido' });
    const pixels = await svc.withToken(req.user.id, ad_account_id, async token => {
      const r = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${actId(ad_account_id)}/adspixels`, {
        params: { access_token: token, fields: 'id,name' }
      });
      return r.data?.data || [];
    });
    res.json(pixels);
  } catch (err) {
    console.error('[Meta Ads] Error listando pixels:', err.response?.data || err.message);
    svc.sendError(res, err, 'No se pudieron cargar los Pixels');
  }
});

// ── POST /api/meta/select-pixel ───────────────────────────────
// (no usa token de Meta: solo guarda la configuración elegida)
router.post('/select-pixel', async (req, res, next) => {
  try {
    const { pixel_id, ad_account_id, currency } = req.body;
    if (!pixel_id) return res.status(400).json({ error: 'pixel_id es requerido' });

    const { data: existing } = await supabase
      .from('ads_config')
      .select('id')
      .eq('user_id', req.user.id)
      .maybeSingle();

    const updates = { pixel_id, conversions_api: true, updated_at: new Date().toISOString() };
    if (ad_account_id) updates.ad_account_id = ad_account_id;
    if (currency) updates.currency = currency;

    if (existing) {
      await supabase.from('ads_config').update(updates).eq('user_id', req.user.id);
    } else {
      await supabase.from('ads_config').insert({ user_id: req.user.id, ...updates });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/meta/create-pixel ──────────────────────────────
// Necesita que el token tenga el permiso "ads_management".
router.post('/create-pixel', async (req, res, next) => {
  try {
    const { ad_account_id, name } = req.body;
    if (!ad_account_id) return res.status(400).json({ error: 'ad_account_id es requerido' });

    const newPixelId = await svc.withToken(req.user.id, ad_account_id, async token => {
      const r = await axios.post(
        `https://graph.facebook.com/${GRAPH_VERSION}/${actId(ad_account_id)}/adspixels`,
        { name: name || 'Pixel AriaBot' },
        { params: { access_token: token } }
      );
      return r.data?.id;
    });
    if (!newPixelId) return res.status(400).json({ error: 'Meta no devolvió el ID del Pixel creado' });

    const { data: existing } = await supabase.from('ads_config').select('id').eq('user_id', req.user.id).maybeSingle();
    const updates = { pixel_id: newPixelId, ad_account_id: actId(ad_account_id), conversions_api: true, updated_at: new Date().toISOString() };
    if (existing) await supabase.from('ads_config').update(updates).eq('user_id', req.user.id);
    else await supabase.from('ads_config').insert({ user_id: req.user.id, ...updates });

    console.log(`[Meta Ads] ✓ Pixel nuevo creado y conectado: ${newPixelId}`);
    res.status(201).json({ pixel_id: newPixelId });
  } catch (err) {
    console.error('[Meta Ads] Error creando Pixel:', err.response?.data || err.message);
    svc.sendError(res, err, 'No se pudo crear el Pixel');
  }
});

// ── GET /api/meta/campaigns?account_id=act_123&date_preset=last_7d ──
// Campañas de una cuenta, con estado real (effective_status) y métricas.
router.get('/campaigns', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { account_id } = req.query;
    if (!account_id) return res.status(400).json({ error: 'account_id es requerido' });
    const preset = presetOf(req.query.date_preset);

    const campaigns = await svc.withToken(req.user.id, account_id, async token => {
      const r = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${actId(account_id)}/campaigns`, {
        params: {
          access_token: token, limit: 200,
          fields: `name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,insights.date_preset(${preset}){${INSIGHT_FIELDS}}`
        },
        timeout: 20000
      });
      return r.data?.data || [];
    });

    const monedaCuenta = await monedaDeCuenta(req.user.id, account_id);
    const monedaDestino = (req.query.currency || 'PEN').toUpperCase();

    const resultado = await Promise.all(campaigns.map(async c => {
      const insights = flatInsights(c);
      const tienePresupuestoPropio = c.daily_budget != null || c.lifetime_budget != null;
      // Meta manda el presupuesto en centavos de la moneda de la cuenta.
      const presupuestoOriginal = tienePresupuestoPropio ? parseInt(c.daily_budget || c.lifetime_budget || 0) / 100 : null;
      const [presupuesto, spendConv] = await Promise.all([
        tienePresupuestoPropio ? convertirMoneda(presupuestoOriginal, monedaCuenta, monedaDestino) : Promise.resolve(null),
        convertirMoneda(parseFloat(insights.spend), monedaCuenta, monedaDestino)
      ]);
      return {
        id: c.id, name: c.name, status: c.status, effective_status: c.effective_status || c.status || 'UNKNOWN',
        objective: c.objective,
        // null = esta campaña NO tiene presupuesto puesto a nivel de
        // campaña (Meta lo está manejando a nivel de conjunto de
        // anuncios en su lugar) — el frontend debe mostrar "-" en
        // ese caso, nunca "PEN 0.00".
        daily_budget: presupuesto !== null ? Number(presupuesto.toFixed(2)) : null,
        budget_type: c.daily_budget != null ? 'diario' : (c.lifetime_budget != null ? 'total' : null),
        start_time: c.start_time, account_id: String(account_id).replace(/^act_/, ''),
        currency: monedaDestino,
        ...insights,
        spend: Number(spendConv.toFixed(2))
      };
    }));

    res.json(resultado);
  } catch (err) {
    console.error('[Meta Ads] Error listando campañas:', err.response?.data || err.message);
    svc.sendError(res, err, 'No se pudieron cargar las campañas');
  }
});

// ── GET /api/meta/adsets?campaign_id=xxx&date_preset=last_7d ────
router.get('/adsets', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { campaign_id } = req.query;
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id es requerido' });
    const preset = presetOf(req.query.date_preset);

    // Sin account_id: se prueba con los tokens de cada perfil hasta
    // encontrar el que tenga acceso a esa campaña.
    const adsets = await svc.withToken(req.user.id, null, async token => {
      const r = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${campaign_id}/adsets`, {
        params: {
          access_token: token, limit: 200,
          fields: `name,status,effective_status,daily_budget,insights.date_preset(${preset}){${INSIGHT_FIELDS}}`
        },
        timeout: 20000
      });
      return r.data?.data || [];
    });

    res.json(adsets.map(a => ({
      id: a.id, name: a.name, status: a.status, effective_status: a.effective_status || a.status || 'UNKNOWN',
      daily_budget: a.daily_budget != null ? Number((parseInt(a.daily_budget) / 100).toFixed(2)) : null, campaign_id, ...flatInsights(a)
    })));
  } catch (err) {
    console.error('[Meta Ads] Error listando conjuntos de anuncios:', JSON.stringify(err.response?.data || { message: err.message }));
    svc.sendError(res, err, 'No se pudieron cargar los conjuntos de anuncios');
  }
});

// ── GET /api/meta/adsets/all?campaign_ids=id1,id2,id3&date_preset= ──
// NUEVO — igual que /adsets, pero para varias campañas A LA VEZ, en
// paralelo. Evita que el frontend tenga que pedirlas una por una
// (que es lo que hacía lento la carga de Campañas).
router.get('/adsets/all', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const campaignIds = String(req.query.campaign_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!campaignIds.length) return res.status(400).json({ error: 'campaign_ids es requerido (separados por coma).' });
    const preset = presetOf(req.query.date_preset);

    const porCampaña = await Promise.all(campaignIds.map(async campaign_id => {
      try {
        const adsets = await svc.withToken(req.user.id, null, async token => {
          const r = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${campaign_id}/adsets`, {
            params: {
              access_token: token, limit: 200,
              fields: `name,status,effective_status,daily_budget,insights.date_preset(${preset}){${INSIGHT_FIELDS}}`
            },
            timeout: 20000
          });
          return r.data?.data || [];
        });
        return {
          campaign_id,
          adsets: adsets.map(a => ({
            id: a.id, name: a.name, status: a.status, effective_status: a.effective_status || a.status || 'UNKNOWN',
            daily_budget: a.daily_budget != null ? Number((parseInt(a.daily_budget) / 100).toFixed(2)) : null, campaign_id, ...flatInsights(a)
          }))
        };
      } catch (err) {
        return { campaign_id, error: svc.metaError(err).message, adsets: [] };
      }
    }));

    res.json(porCampaña);
  } catch (err) {
    console.error('[Meta Ads] Error listando conjuntos de anuncios (lote):', JSON.stringify(err.response?.data || { message: err.message }));
    svc.sendError(res, err, 'No se pudieron cargar los conjuntos de anuncios');
  }
});

// ── GET /api/meta/ads?adset_id=xxx&date_preset=last_30d ─────────
router.get('/ads', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { adset_id } = req.query;
    if (!adset_id) return res.status(400).json({ error: 'adset_id es requerido' });
    const preset = presetOf(req.query.date_preset);

    const ads = await svc.withToken(req.user.id, null, async token => {
      const r = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${adset_id}/ads`, {
        params: {
          access_token: token, limit: 200,
          fields: `name,status,effective_status,insights.date_preset(${preset}){${INSIGHT_FIELDS}}`
        },
        timeout: 20000
      });
      return r.data?.data || [];
    });

    res.json(ads.map(ad => ({
      id: ad.id, name: ad.name, status: ad.status, effective_status: ad.effective_status, ...flatInsights(ad)
    })));
  } catch (err) {
    console.error('[Meta Ads] Error listando anuncios:', err.response?.data || err.message);
    svc.sendError(res, err, 'No se pudieron cargar los anuncios');
  }
});

// ── POST /api/meta/campaigns/:id/status  { status: 'ACTIVE'|'PAUSED' } ──
// ── POST /api/meta/adsets/:id/status ─────────────────────────
// ── POST /api/meta/ads/:id/status ────────────────────────────
// Pausar/activar — necesita que el token tenga el permiso
// "ads_management" (no alcanza con "ads_read", que es de solo
// lectura). Si el token no lo tiene, Meta lo rechaza con un error
// claro que se le pasa tal cual al usuario.
function crearRutaDeEstado(tipo) {
  return async (req, res, next) => {
    try {
      const status = String(req.body?.status || '').toUpperCase();
      if (!['ACTIVE', 'PAUSED'].includes(status)) return res.status(400).json({ error: 'status debe ser ACTIVE o PAUSED.' });

      await svc.withToken(req.user.id, null, async token => {
        await axios.post(
          `https://graph.facebook.com/${GRAPH_VERSION}/${req.params.id}`,
          null,
          { params: { status, access_token: token }, timeout: 20000 }
        );
      });
      res.json({ success: true, status });
    } catch (err) {
      console.error(`[Meta Ads] Error cambiando estado de ${tipo}:`, JSON.stringify(err.response?.data || { message: err.message }));
      svc.sendError(res, err, `No se pudo cambiar el estado de ${tipo}.`);
    }
  };
}
router.post('/campaigns/:id/status', crearRutaDeEstado('la campaña'));
router.post('/adsets/:id/status', crearRutaDeEstado('el conjunto de anuncios'));
router.post('/ads/:id/status', crearRutaDeEstado('el anuncio'));

// ── POST /api/meta/campaigns/:id/budget  { daily_budget: 50, currency: 'PEN' } ──
// ── POST /api/meta/adsets/:id/budget ─────────────────────────
// El monto que manda el frontend viene en la moneda que el usuario
// esté viendo en pantalla — se convierte a la moneda REAL de la
// cuenta antes de mandarlo a Meta (que siempre lo espera en la
// moneda de la cuenta, en centavos).
function crearRutaDePresupuesto(tipo) {
  return async (req, res, next) => {
    try {
      const montoIngresado = parseFloat(req.body?.daily_budget);
      const monedaIngresada = (req.body?.currency || 'PEN').toUpperCase();
      if (!montoIngresado || montoIngresado <= 0) return res.status(400).json({ error: 'Ingresa un presupuesto válido, mayor a 0.' });

      await svc.withToken(req.user.id, null, async (token, c) => {
        let monedaCuenta = 'PEN';
        if (c.profileId) {
          const cuentas = await svc.listAllAccounts(req.user.id);
          const match = cuentas.find(a => a.profile_id === c.profileId);
          if (match) monedaCuenta = match.currency || 'PEN';
        }
        const montoEnMonedaDeLaCuenta = await convertirMoneda(montoIngresado, monedaIngresada, monedaCuenta);
        const centavos = Math.round(montoEnMonedaDeLaCuenta * 100);

        await axios.post(
          `https://graph.facebook.com/${GRAPH_VERSION}/${req.params.id}`,
          null,
          { params: { daily_budget: centavos, access_token: token }, timeout: 20000 }
        );
      });
      res.json({ success: true });
    } catch (err) {
      console.error(`[Meta Ads] Error cambiando presupuesto de ${tipo}:`, JSON.stringify(err.response?.data || { message: err.message }));
      svc.sendError(res, err, `No se pudo actualizar el presupuesto de ${tipo}. Si la campaña usa presupuesto a nivel de CBO (Campaign Budget Optimization) o tiene reglas automáticas activas, Meta puede rechazar el cambio.`);
    }
  };
}
router.post('/campaigns/:id/budget', crearRutaDePresupuesto('la campaña'));
router.post('/adsets/:id/budget', crearRutaDePresupuesto('el conjunto de anuncios'));

module.exports = router;
