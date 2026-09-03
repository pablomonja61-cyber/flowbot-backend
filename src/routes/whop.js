const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

router.use(auth);

const WHOP_CLIENT_ID = process.env.WHOP_CLIENT_ID;
const WHOP_REDIRECT_URI = process.env.WHOP_REDIRECT_URI; // ej. https://ariabot.app/whop/callback

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── GET /api/whop/connect ────────────────────────────────────
// Genera la URL de autorización de Whop (con PKCE) y la devuelve
// para que el frontend redirija al usuario ahí.
router.get('/connect', async (req, res, next) => {
  try {
    if (!WHOP_CLIENT_ID || !WHOP_REDIRECT_URI) {
      return res.status(500).json({ error: 'Whop no está configurado en el servidor (falta WHOP_CLIENT_ID o WHOP_REDIRECT_URI)' });
    }

    // PKCE: se genera un "code_verifier" secreto, y se manda su hash
    // (code_challenge) a Whop. Al volver, hay que mandar el verifier
    // original para probar que la petición es de la misma sesión.
    const codeVerifier = base64url(crypto.randomBytes(32));
    const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
    const state = base64url(crypto.randomBytes(16));

    // Se guarda temporalmente para poder recuperarlo en el callback.
    await supabase.from('whop_oauth_states').insert({
      id: uuidv4(),
      state,
      code_verifier: codeVerifier,
      user_id: req.user.id,
      created_at: new Date().toISOString()
    });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: WHOP_CLIENT_ID,
      redirect_uri: WHOP_REDIRECT_URI,
      scope: 'openid profile email',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });

    res.json({ url: `https://api.whop.com/oauth/authorize?${params.toString()}` });
  } catch (err) { next(err); }
});

// ── POST /api/whop/callback ──────────────────────────────────
// Recibe el "code" y "state" que Whop mandó de vuelta, y los
// intercambia por el access_token real.
router.post('/callback', async (req, res, next) => {
  try {
    const { code, state } = req.body;
    if (!code || !state) {
      return res.status(400).json({ error: 'code y state son requeridos' });
    }

    const { data: stored } = await supabase
      .from('whop_oauth_states')
      .select('*')
      .eq('state', state)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!stored) {
      return res.status(400).json({ error: 'Esta conexión ya venció o no es válida. Intenta conectar de nuevo.' });
    }

    const tokenResponse = await axios.post(
      'https://api.whop.com/oauth/token',
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: WHOP_REDIRECT_URI,
        client_id: WHOP_CLIENT_ID,
        code_verifier: stored.code_verifier
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    // Traer el nombre de la cuenta de Whop, para mostrarlo en la tarjeta
    let whopName = 'Cuenta de Whop';
    try {
      const userInfoRes = await axios.get('https://api.whop.com/oauth/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
        timeout: 10000
      });
      whopName = userInfoRes.data?.name || userInfoRes.data?.preferred_username || whopName;
    } catch (e) {
      console.error('[Whop] No se pudo traer el nombre de la cuenta:', e.message);
    }

    const expiresAt = new Date(Date.now() + (expires_in || 3600) * 1000).toISOString();

    const { data: existing } = await supabase
      .from('whop_connections')
      .select('id')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (existing) {
      await supabase.from('whop_connections').update({
        access_token, refresh_token, expires_at: expiresAt, whop_name: whopName,
        updated_at: new Date().toISOString()
      }).eq('user_id', req.user.id);
    } else {
      await supabase.from('whop_connections').insert({
        id: uuidv4(), user_id: req.user.id,
        access_token, refresh_token, expires_at: expiresAt, whop_name: whopName,
        created_at: new Date().toISOString()
      });
    }

    // El código de un solo uso ya se gastó, se borra
    await supabase.from('whop_oauth_states').delete().eq('id', stored.id);

    res.json({ success: true, name: whopName });
  } catch (err) {
    console.error('[Whop] Error en callback:', err.response?.data || err.message);
    res.status(400).json({ error: 'No se pudo conectar tu cuenta de Whop. Intenta de nuevo.' });
  }
});

// ── GET /api/whop/status ─────────────────────────────────────
// Para que la tarjeta de Conexiones sepa si ya hay una cuenta
// conectada, y con qué nombre mostrarla.
router.get('/status', async (req, res, next) => {
  try {
    const { data } = await supabase
      .from('whop_connections')
      .select('whop_name, created_at')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!data) return res.json({ connected: false });
    res.json({ connected: true, name: data.whop_name, connected_at: data.created_at });
  } catch (err) { next(err); }
});

// ── DELETE /api/whop/disconnect ──────────────────────────────
router.delete('/disconnect', async (req, res, next) => {
  try {
    const { data: existing } = await supabase
      .from('whop_connections')
      .select('*')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (existing?.refresh_token) {
      try {
        await axios.post('https://api.whop.com/oauth/revoke', {
          token: existing.refresh_token, client_id: WHOP_CLIENT_ID
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
      } catch (e) {
        console.error('[Whop] Error revocando token:', e.message);
      }
    }

    await supabase.from('whop_connections').delete().eq('user_id', req.user.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
