// routes/apiTokens.js
// Generar y revocar tokens de API personales, para conectar AriaBot
// a Claude/ChatGPT (u otras herramientas) vía MCP.
// Móntala con: app.use('/api/api-tokens', require('./routes/apiTokens'));

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const crypto = require('crypto');

router.use(auth);

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ── GET /api/api-tokens ──────────────────────────────────────
// Lista los tokens del usuario (nunca devuelve el token real, solo
// cuándo se creó y cuándo se usó por última vez).
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('api_tokens')
      .select('id, name, created_at, last_used_at, revoked')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { next(err); }
});

// ── POST /api/api-tokens ─────────────────────────────────────
// Crea un token nuevo. El token real (sin hashear) se devuelve UNA
// SOLA VEZ aquí — el usuario debe copiarlo ya, no se puede volver a
// mostrar después (solo guardamos su hash).
router.post('/', async (req, res, next) => {
  try {
    const name = (req.body?.name || 'Token MCP').slice(0, 100);
    const rawToken = 'ariabot_' + crypto.randomBytes(32).toString('hex');

    const { data, error } = await supabase
      .from('api_tokens')
      .insert({ user_id: req.user.id, name, token_hash: hashToken(rawToken) })
      .select('id, name, created_at')
      .single();
    if (error) throw error;

    res.status(201).json({ ...data, token: rawToken });
  } catch (err) { next(err); }
});

// ── DELETE /api/api-tokens/:id ───────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('api_tokens')
      .update({ revoked: true })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
