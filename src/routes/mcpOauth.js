// routes/mcpOauth.js
// OAuth 2.1 para el servidor MCP de AriaBot (Claude, ChatGPT, etc. se
// conectan solo con la URL: la persona inicia sesión y aprueba, sin
// copiar ningún token).
//
// Implementa: metadatos (RFC 9728 / RFC 8414), registro dinámico de
// clientes (RFC 7591), código de autorización + PKCE S256 y refresh
// tokens con rotación. Los códigos y tokens se guardan SOLO como hash.
//
// Montaje en index.js (ver notas al final del archivo):
//   const { wellKnown, oauthRouter } = require('./routes/mcpOauth');
//   app.use(wellKnown);            // /.well-known/...
//   app.use('/oauth', oauthRouter);

const express = require('express');
const crypto = require('crypto');
const supabase = require('../models/supabase');

let createClient = null;
try { ({ createClient } = require('@supabase/supabase-js')); } catch (e) { /* se usa el cliente compartido */ }

const ISSUER = (process.env.MCP_PUBLIC_URL || 'https://mcp.ariabot.app').replace(/\/+$/, '');
const ACCESS_TTL_MS = 60 * 60 * 1000;                 // 1 hora
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;      // 90 días
const CODE_TTL_MS = 5 * 60 * 1000;                    // 5 minutos

const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const rand = (prefix, bytes = 32) => prefix + crypto.randomBytes(bytes).toString('hex');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

// ── Límite simple de intentos (por IP) ──────────────────────────
const intentos = new Map();
function limitado(req, clave, max, ventanaMs) {
  const k = clave + ':' + (req.ip || 'x');
  const ahora = Date.now();
  const lista = (intentos.get(k) || []).filter(t => ahora - t < ventanaMs);
  lista.push(ahora);
  intentos.set(k, lista);
  if (intentos.size > 5000) intentos.clear();
  return lista.length > max;
}

function uriPermitida(uri) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch { return false; }
}

// ── Metadatos ───────────────────────────────────────────────────
const wellKnown = express.Router();
wellKnown.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });
const recurso = { resource: ISSUER + '/mcp', authorization_servers: [ISSUER], bearer_methods_supported: ['header'], scopes_supported: ['mcp'] };
const servidor = {
  issuer: ISSUER,
  authorization_endpoint: ISSUER + '/oauth/authorize',
  token_endpoint: ISSUER + '/oauth/token',
  registration_endpoint: ISSUER + '/oauth/register',
  revocation_endpoint: ISSUER + '/oauth/revoke',
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  scopes_supported: ['mcp']
};
for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) wellKnown.get(p, (req, res) => res.json(recurso));
for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration']) wellKnown.get(p, (req, res) => res.json(servidor));

// ── Router principal /oauth ─────────────────────────────────────
const oauthRouter = express.Router();
oauthRouter.use(express.urlencoded({ extended: false, limit: '20kb' }));
oauthRouter.use(express.json({ limit: '20kb' }));
oauthRouter.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.path !== '/authorize') {   // endpoints de máquina: CORS abierto (no usan cookies)
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  next();
});

const oauthError = (res, status, error, description) => res.status(status).json({ error, error_description: description });

// POST /oauth/register — registro dinámico de clientes
oauthRouter.post('/register', async (req, res, next) => {
  try {
    if (limitado(req, 'register', 30, 60 * 60 * 1000)) return oauthError(res, 429, 'temporarily_unavailable', 'Demasiados registros. Intenta más tarde.');
    const { client_name, redirect_uris, token_endpoint_auth_method } = req.body || {};
    if (!Array.isArray(redirect_uris) || !redirect_uris.length || redirect_uris.length > 10 || !redirect_uris.every(uriPermitida)) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris debe contener URLs https (o http://localhost).');
    }
    const secreto = rand('ariasec_', 24);
    const nombre = String(client_name || 'Cliente MCP').slice(0, 100);
    const { data, error } = await supabase.from('oauth_clients')
      .insert({ client_secret: sha256(secreto), client_name: nombre, redirect_uris })
      .select('client_id, created_at').single();
    if (error) throw error;
    const confidencial = token_endpoint_auth_method === 'client_secret_post';
    res.status(201).json({
      client_id: data.client_id,
      ...(confidencial ? { client_secret: secreto } : {}),
      client_id_issued_at: Math.floor(new Date(data.created_at).getTime() / 1000),
      client_name: nombre, redirect_uris,
      token_endpoint_auth_method: confidencial ? 'client_secret_post' : 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code']
    });
  } catch (err) { next(err); }
});

async function validarSolicitud(p) {
  if (p.response_type !== 'code') return 'Solo se admite response_type=code.';
  if (!isUuid(p.client_id)) return 'client_id inválido.';
  if (!p.code_challenge || p.code_challenge_method !== 'S256') return 'Se requiere PKCE con code_challenge_method=S256.';
  const { data: cliente } = await supabase.from('oauth_clients').select('client_id, client_name, redirect_uris').eq('client_id', p.client_id).maybeSingle();
  if (!cliente) return 'Cliente no registrado.';
  if (!cliente.redirect_uris.includes(p.redirect_uri)) return 'redirect_uri no coincide con el registrado.';
  return { cliente };
}

function pagina(p, cliente, error = '') {
  const oculto = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope']
    .map(k => `<input type="hidden" name="${k}" value="${esc(p[k] || '')}">`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Conectar con AriaBot</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a}
.card{width:min(420px,92vw);background:#fff;border-radius:16px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.35)}h1{font-size:20px;margin:0 0 6px}p{margin:0 0 16px;color:#475569;font-size:14px;line-height:1.5}
label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}input[type=email],input[type=password]{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:15px}
button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:10px;background:#16a34a;color:#fff;font-size:15px;font-weight:600;cursor:pointer}.err{background:#fef2f2;color:#b91c1c;padding:10px 12px;border-radius:10px;font-size:13px;margin-bottom:8px}
.sm{font-size:12px;color:#64748b;margin-top:14px}</style></head><body><main class="card"><h1>Conectar con AriaBot</h1>
<p><strong>${esc(cliente.client_name)}</strong> quiere acceder a tus datos de AriaBot (ventas, conversaciones y contactos) para responder tus preguntas. Inicia sesión para autorizar.</p>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
<form method="post" action="/oauth/authorize" autocomplete="on">${oculto}
<label for="email">Correo</label><input id="email" name="email" type="email" required autocomplete="username" autofocus>
<label for="password">Contraseña</label><input id="password" name="password" type="password" required autocomplete="current-password">
<button type="submit">Iniciar sesión y autorizar</button></form>
<p class="sm">Podrás revocar este acceso cuando quieras desde Configuraciones → Herramientas MCP.</p></main></body></html>`;
}

// GET /oauth/authorize
oauthRouter.get('/authorize', async (req, res, next) => {
  try {
    const r = await validarSolicitud(req.query);
    if (typeof r === 'string') return res.status(400).type('text').send('Solicitud inválida: ' + r);
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'");
    res.type('html').send(pagina(req.query, r.cliente));
  } catch (err) { next(err); }
});

// POST /oauth/authorize — valida credenciales y emite el código
oauthRouter.post('/authorize', async (req, res, next) => {
  try {
    const p = req.body || {};
    const r = await validarSolicitud(p);
    if (typeof r === 'string') return res.status(400).type('text').send('Solicitud inválida: ' + r);
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'");
    if (limitado(req, 'login', 10, 15 * 60 * 1000)) return res.status(429).type('html').send(pagina(p, r.cliente, 'Demasiados intentos. Espera unos minutos.'));

    const email = String(p.email || '').trim().toLowerCase(), password = String(p.password || '');
    if (!email || !password) return res.status(400).type('html').send(pagina(p, r.cliente, 'Escribe tu correo y contraseña.'));

    // Cliente aparte para no contaminar la sesión del cliente de servicio.
    const auth = createClient && process.env.SUPABASE_URL
      ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }).auth
      : supabase.auth;
    const { data: sesion, error: loginError } = await auth.signInWithPassword({ email, password });
    if (loginError || !sesion?.user) return res.status(401).type('html').send(pagina(p, r.cliente, 'Correo o contraseña incorrectos.'));

    const { data: perfil } = await supabase.from('users').select('id, owner_id, email_verified').eq('id', sesion.user.id).maybeSingle();
    if (!perfil || perfil.email_verified === false) return res.status(403).type('html').send(pagina(p, r.cliente, 'Tu cuenta todavía no está verificada.'));
    const duenoId = perfil.owner_id || perfil.id; // los miembros del equipo ven los datos del dueño

    const code = rand('ariacode_', 32);
    const { error } = await supabase.from('oauth_codes').insert({
      code: sha256(code), client_id: r.cliente.client_id, user_id: duenoId, redirect_uri: p.redirect_uri,
      code_challenge: p.code_challenge, code_challenge_method: 'S256', expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString()
    });
    if (error) throw error;

    const destino = new URL(p.redirect_uri);
    destino.searchParams.set('code', code);
    if (p.state) destino.searchParams.set('state', p.state);
    res.redirect(302, destino.toString());
  } catch (err) { next(err); }
});

async function emitirTokens(clientId, userId) {
  const access = rand('ariaat_'), refresh = rand('ariart_');
  const { error } = await supabase.from('oauth_tokens').insert({
    access_token: sha256(access), refresh_token: sha256(refresh), client_id: clientId, user_id: userId,
    expires_at: new Date(Date.now() + ACCESS_TTL_MS).toISOString()
  });
  if (error) throw error;
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: 'mcp' };
}

async function autenticarCliente(body) {
  if (!isUuid(body.client_id)) return null;
  const { data: c } = await supabase.from('oauth_clients').select('client_id, client_secret').eq('client_id', body.client_id).maybeSingle();
  if (!c) return null;
  if (body.client_secret) {
    const a = Buffer.from(sha256(String(body.client_secret))), b = Buffer.from(c.client_secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  }
  return c;
}

// POST /oauth/token
oauthRouter.post('/token', async (req, res, next) => {
  try {
    if (limitado(req, 'token', 120, 15 * 60 * 1000)) return oauthError(res, 429, 'temporarily_unavailable', 'Demasiadas solicitudes.');
    const b = req.body || {};
    const cliente = await autenticarCliente(b);
    if (!cliente) return oauthError(res, 401, 'invalid_client', 'Cliente no válido.');

    if (b.grant_type === 'authorization_code') {
      const hash = sha256(String(b.code || ''));
      const { data: fila } = await supabase.from('oauth_codes').select('*').eq('code', hash).maybeSingle();
      if (!fila) return oauthError(res, 400, 'invalid_grant', 'Código inválido.');
      // Un código se usa una sola vez: se borra antes de seguir.
      await supabase.from('oauth_codes').delete().eq('code', hash);
      if (fila.client_id !== cliente.client_id || new Date(fila.expires_at) < new Date()) return oauthError(res, 400, 'invalid_grant', 'Código vencido o de otro cliente.');
      if (fila.redirect_uri !== b.redirect_uri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri no coincide.');
      const verificador = String(b.code_verifier || '');
      const calculado = crypto.createHash('sha256').update(verificador).digest('base64url');
      if (verificador.length < 43 || calculado !== fila.code_challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE no coincide.');
      return res.json(await emitirTokens(cliente.client_id, fila.user_id));
    }

    if (b.grant_type === 'refresh_token') {
      const hash = sha256(String(b.refresh_token || ''));
      const { data: fila } = await supabase.from('oauth_tokens').select('*').eq('refresh_token', hash).maybeSingle();
      if (!fila || fila.client_id !== cliente.client_id) return oauthError(res, 400, 'invalid_grant', 'Refresh token inválido.');
      const vencido = new Date(fila.created_at).getTime() + REFRESH_TTL_MS < Date.now();
      if (fila.revoked || vencido) return oauthError(res, 400, 'invalid_grant', 'Refresh token revocado o vencido.');
      // Rotación: el refresh token anterior deja de servir.
      await supabase.from('oauth_tokens').update({ revoked: true }).eq('refresh_token', hash);
      return res.json(await emitirTokens(cliente.client_id, fila.user_id));
    }

    oauthError(res, 400, 'unsupported_grant_type', 'Usa authorization_code o refresh_token.');
  } catch (err) { next(err); }
});

// POST /oauth/revoke (RFC 7009)
oauthRouter.post('/revoke', async (req, res, next) => {
  try {
    const cliente = await autenticarCliente(req.body || {});
    if (cliente && req.body.token) {
      const hash = sha256(String(req.body.token));
      await supabase.from('oauth_tokens').update({ revoked: true }).eq('client_id', cliente.client_id).or(`access_token.eq.${hash},refresh_token.eq.${hash}`);
    }
    res.status(200).json({});
  } catch (err) { next(err); }
});

// Usado por mcp.js: devuelve el user_id del dueño o null.
async function userIdDesdeAccessToken(token) {
  if (!token || !token.startsWith('ariaat_')) return null;
  const hash = sha256(token);
  const { data } = await supabase.from('oauth_tokens').select('user_id, expires_at, revoked, client_id').eq('access_token', hash).maybeSingle();
  if (!data || data.revoked || new Date(data.expires_at) < new Date()) return null;
  return { userId: data.user_id, clientId: data.client_id };
}

module.exports = { wellKnown, oauthRouter, userIdDesdeAccessToken, ISSUER };
