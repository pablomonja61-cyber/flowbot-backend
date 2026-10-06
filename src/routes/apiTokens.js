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
      .select('id, name, created_at, last_used_at')
      .eq('user_id', req.user.id)
      .eq('revoked', false)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const estaticos = (data || []).map(t => ({ ...t, type: 'static', expires_at: null }));

    // Conexiones OAuth (Claude, ChatGPT…): una fila por cliente.
    const { data: grants } = await supabase
      .from('oauth_tokens')
      .select('client_id, created_at, expires_at, revoked, oauth_clients(client_name)')
      .eq('user_id', req.user.id)
      .eq('revoked', false)
      .order('created_at', { ascending: false })
      .limit(500);
    const porCliente = new Map();
    for (const g of grants || []) {
      const actual = porCliente.get(g.client_id);
      const vence = new Date(g.created_at).getTime() + 90 * 24 * 60 * 60 * 1000;
      if (!actual) porCliente.set(g.client_id, { id: 'oauth:' + g.client_id, name: (g.oauth_clients?.client_name || 'Cliente MCP') + ' (OAuth)', created_at: g.created_at, last_used_at: g.created_at, type: 'oauth', expires_at: new Date(vence).toISOString() });
      else if (new Date(g.created_at) < new Date(actual.created_at)) actual.created_at = g.created_at;
    }
    res.json([...estaticos, ...porCliente.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
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
    if (req.params.id.startsWith('oauth:')) {
      const clientId = req.params.id.slice(6);
      if (!/^[0-9a-f-]{36}$/i.test(clientId)) return res.status(400).json({ error: 'Identificador no válido.' });
      const { error: e2 } = await supabase.from('oauth_tokens').update({ revoked: true }).eq('client_id', clientId).eq('user_id', req.user.id);
      if (e2) throw e2;
      return res.json({ success: true });
    }
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
