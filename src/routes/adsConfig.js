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

    // Para usar SOLO el Pixel (Conversions API, registrar compras), solo
    // hacen falta pixel_id + access_token — el Ad Account ID es un dato
    // aparte, de un sistema distinto de Meta (Ads Manager), que solo se
    // necesita si además quieres ver el Dashboard de métricas de
    // anuncios dentro de AriaBot. No deben mezclarse ni exigirse juntos.
    if (!access_token) {
      return res.status(400).json({ error: 'El Access Token es requerido' });
    }
    if (!pixel_id && !ad_account_id) {
      return res.status(400).json({ error: 'Debes ingresar al menos el Pixel ID (para registrar compras) o el Ad Account ID (para ver métricas de anuncios)' });
    }

    // Solo se verifica contra el Ads Manager si de verdad se mandó un
    // Ad Account ID — si el usuario solo quiere el Pixel, este paso se
    // salta por completo (el token del Pixel no tiene por qué tener
    // permisos de ads_read/ads_management, son cosas distintas).
    if (ad_account_id) {
      try {
        await axios.get(
          `https://graph.facebook.com/v26.0/act_${ad_account_id.replace('act_', '')}`,
          {
            params: { fields: 'id,name', access_token },
            timeout: 10000
          }
        );
      } catch (e) {
        console.error('[Ads Config] Error verificando credenciales con Meta:', e.response?.data || e.message);
        return res.status(400).json({ error: 'Token o Ad Account ID inválido para el Ads Manager. Si solo quieres usar el Pixel, deja el campo de Ad Account ID vacío.' });
      }
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