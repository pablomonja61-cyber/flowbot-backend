// routes/mcp.js
// El servidor MCP de AriaBot — permite conectar la cuenta desde
// Claude, ChatGPT u otras herramientas de IA compatibles con MCP,
// para consultar los datos propios del usuario (ventas, chats,
// contactos) con lenguaje natural.
//
// Requiere el paquete oficial del protocolo:
//   npm install @modelcontextprotocol/sdk
//
// Móntala en index.js con: app.use('/mcp', require('./routes/mcp'));
// (sin /api delante — así queda en https://TU_BACKEND/mcp)

const express = require('express');
const router = express.Router();
const supabase = require('../models/supabase');
const crypto = require('crypto');
let oauth = null;
try { oauth = require('./mcpOauth'); } catch (e) { console.warn('[MCP] OAuth no disponible:', e.message); }

let McpServer, StreamableHTTPServerTransport, z;
try {
  ({ McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js'));
  ({ StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js'));
  z = require('zod');
} catch (e) {
  console.error('[MCP] Falta el paquete @modelcontextprotocol/sdk (y/o zod) — el servidor MCP queda desactivado. Ejecuta: npm install @modelcontextprotocol/sdk zod');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ── Autenticación: Token estático (Bearer) u OAuth ──────────────
// Si falta el token o no sirve, se responde 401 con la ruta de metadatos
// OAuth para que Claude/ChatGPT inicien el login automáticamente.
function noAutorizado(res, mensaje) {
  const base = (process.env.MCP_PUBLIC_URL || 'https://mcp.ariabot.app').replace(/\/+$/, '');
  res.set('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
  return res.status(401).json({ error: mensaje });
}
async function authByToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) return noAutorizado(res, 'Falta el token de acceso.');

  if (token.startsWith('ariaat_')) {
    const r = oauth ? await oauth.userIdDesdeAccessToken(token) : null;
    if (!r) return noAutorizado(res, 'Token OAuth inválido o vencido.');
    req.mcpUserId = r.userId;
    return next();
  }

  const { data, error } = await supabase
    .from('api_tokens')
    .select('id, user_id, revoked')
    .eq('token_hash', hashToken(token))
    .maybeSingle();

  if (error || !data || data.revoked) return noAutorizado(res, 'Token inválido o revocado.');

  supabase.from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id).then(() => {});
  req.mcpUserId = data.user_id;
  next();
}

// ── Construye un servidor MCP nuevo, con las herramientas ───────
// (se crea uno por cada petición — es el patrón recomendado para
// el transporte "stateless" HTTP)
function buildServer(userId) {
  const server = new McpServer({ name: 'ariabot', version: '1.0.0' });

  server.registerTool('obtener_estadisticas', {
    title: 'Obtener estadísticas del negocio',
    description: 'Da un resumen de ventas, conversaciones y facturación en un rango de fechas (hoy, 7d, 30d).',
    inputSchema: { range: z.enum(['today', '7d', '30d']).default('today') }
  }, async ({ range }) => {
    const desde = new Date();
    if (range === '7d') desde.setDate(desde.getDate() - 7);
    else if (range === '30d') desde.setDate(desde.getDate() - 30);
    else desde.setHours(0, 0, 0, 0);

    const { data: convs } = await supabase
      .from('conversations')
      .select('is_sale, sale_amount')
      .eq('user_id', userId)
      .gte('created_at', desde.toISOString());

    const total = convs?.length || 0;
    const ventas = (convs || []).filter(c => c.is_sale);
    const facturacion = ventas.reduce((s, c) => s + (Number(c.sale_amount) || 0), 0);

    return { content: [{ type: 'text', text: JSON.stringify({
      conversaciones: total, ventas: ventas.length, facturacion_soles: facturacion,
      tasa_conversion_pct: total ? Number((100 * ventas.length / total).toFixed(1)) : 0
    }, null, 2) }] };
  });

  server.registerTool('listar_ventas', {
    title: 'Listar ventas recientes',
    description: 'Devuelve las últimas ventas confirmadas, con nombre del cliente, monto y fecha.',
    inputSchema: { limite: z.number().min(1).max(50).default(10) }
  }, async ({ limite }) => {
    const { data } = await supabase
      .from('conversations')
      .select('contact_name, contact_phone, sale_amount, sale_method, sale_at')
      .eq('user_id', userId)
      .eq('is_sale', true)
      .order('sale_at', { ascending: false })
      .limit(limite);
    return { content: [{ type: 'text', text: JSON.stringify(data || [], null, 2) }] };
  });

  server.registerTool('listar_conversaciones', {
    title: 'Listar conversaciones de WhatsApp',
    description: 'Devuelve las conversaciones más recientes, con su estado y último mensaje.',
    inputSchema: { limite: z.number().min(1).max(50).default(10) }
  }, async ({ limite }) => {
    const { data } = await supabase
      .from('conversations')
      .select('contact_name, contact_phone, last_message, last_message_at, is_sale, status')
      .eq('user_id', userId)
      .order('last_message_at', { ascending: false })
      .limit(limite);
    return { content: [{ type: 'text', text: JSON.stringify(data || [], null, 2) }] };
  });

  server.registerTool('listar_contactos', {
    title: 'Listar contactos guardados',
    description: 'Devuelve los contactos guardados en el CRM de AriaBot.',
    inputSchema: { limite: z.number().min(1).max(50).default(10) }
  }, async ({ limite }) => {
    const { data } = await supabase
      .from('contacts')
      .select('name, phone, email, status, tags')
      .eq('user_id', userId)
      .order('name')
      .limit(limite);
    return { content: [{ type: 'text', text: JSON.stringify(data || [], null, 2) }] };
  });

  return server;
}

// ── Punto de entrada MCP (protocolo Streamable HTTP) ─────────────
router.post('/', authByToken, async (req, res) => {
  if (!McpServer) return res.status(503).json({ error: 'El servidor MCP no está disponible (falta instalar dependencias).' });
  try {
    const server = buildServer(req.mcpUserId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[MCP] Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Error interno del servidor MCP.' });
  }
});

// Servidor sin sesión: no hay flujo GET/DELETE.
const noPermitido = (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Método no permitido.' }, id: null });
router.get('/', noPermitido);
router.delete('/', noPermitido);

module.exports = router;
