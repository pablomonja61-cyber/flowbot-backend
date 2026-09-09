const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const axios = require('axios');

router.use(auth);

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const GRAPH_VERSION = 'v26.0';
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

// ── GET /api/meta/adaccounts ──────────────────────────────────
// Lista las cuentas publicitarias a las que el token conectado
// tiene acceso, para que el usuario elija cuál usar.
router.get('/adaccounts', async (req, res, next) => {
  try {
    const { data: config } = await supabase
      .from('ads_config')
      .select('access_token')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!config?.access_token) {
      return res.status(404).json({ error: 'No hay una cuenta de Meta Ads conectada todavía' });
    }

    const accountsRes = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/me/adaccounts`, {
      params: {
        access_token: config.access_token,
        fields: 'id,name,account_status,currency'
      }
    });

    res.json(accountsRes.data?.data || []);
  } catch (err) {
    console.error('[Meta Ads] Error listando cuentas:', err.response?.data || err.message);
    next(err);
  }
});

// ── GET /api/meta/pixels?ad_account_id=act_123 ────────────────
// Lista los Pixels que ya existen en esa cuenta de anuncios — así
// el usuario no tiene que escribir el Pixel ID a mano, solo elegir
// de una lista (o se usa el único que tenga, automáticamente).
router.get('/pixels', async (req, res, next) => {
  try {
    const { ad_account_id } = req.query;
    if (!ad_account_id) return res.status(400).json({ error: 'ad_account_id es requerido' });

    const { data: config } = await supabase
      .from('ads_config')
      .select('access_token, currency')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!config?.access_token) {
      return res.status(404).json({ error: 'No hay una cuenta de Meta Ads conectada todavía' });
    }

    const accountId = ad_account_id.startsWith('act_') ? ad_account_id : `act_${ad_account_id}`;

    const pixelsRes = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${accountId}/adspixels`, {
      params: { access_token: config.access_token, fields: 'id,name' }
    });

    res.json(pixelsRes.data?.data || []);
  } catch (err) {
    console.error('[Meta Ads] Error listando pixels:', err.response?.data || err.message);
    next(err);
  }
});

// ── POST /api/meta/select-pixel ───────────────────────────────
// Guarda el Pixel elegido (o el único que había) junto con el resto
// de la config — usa el mismo access_token ya conectado, sin pedir
// otro token aparte para esto.
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

module.exports = router;
