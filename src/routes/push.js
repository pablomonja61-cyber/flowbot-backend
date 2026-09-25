const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const webPush = require('web-push');

router.use(auth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function vapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || '', privateKey = process.env.VAPID_PRIVATE_KEY || '', subject = process.env.VAPID_SUBJECT || '';
  if (!publicKey || !privateKey || !/^(mailto:|https:\/\/)/.test(subject)) return null;
  try { webPush.setVapidDetails(subject, publicKey, privateKey); } catch { return null; }
  return { subject, publicKey, privateKey };
}
function validEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint), host = url.hostname;
    const provider = host === 'fcm.googleapis.com' || host === 'web.push.apple.com' || host.endsWith('.push.apple.com') || host === 'updates.push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com') || host.endsWith('.notify.windows.com');
    return provider && url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash;
  } catch { return false; }
}
function validKey(value, length) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(value) && value.length < 150 && Buffer.from(value, 'base64url').length === length;
}
function validSubscription(input) {
  return !!(input && validEndpoint(input.endpoint) && validKey(input.keys?.p256dh, 65) && Buffer.from(input.keys.p256dh, 'base64url')[0] === 4 && validKey(input.keys?.auth, 16) && (input.expirationTime == null || (Number.isFinite(input.expirationTime) && input.expirationTime >= 0)));
}
function notification(sale) {
  const raw = sale.sale_amount_usd ?? (sale.sale_currency === 'USD' ? sale.sale_amount : null);
  const amount = raw === null || raw === undefined || raw === '' ? null : Number(raw);
  return { title: 'Venta aprobada', body: amount !== null && Number.isFinite(amount) ? 'Valor: $' + amount.toFixed(2) : 'Importe en USD no disponible', icon: '/assets/brand/favicon.png', badge: '/assets/brand/favicon.png', tag: 'ariabot-sale-' + sale.id + '-' + (sale.sale_at || 'approved'), data: { url: '/chat.html?chat=' + encodeURIComponent(sale.id) } };
}
router.get('/config', async (req, res, next) => {
  try {
    const config = vapid();
    const { count, error } = await supabase.from('push_subscriptions').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ available: !!config, publicKey: config?.publicKey || '', hasDevices: count > 0 });
  } catch (error) { next(error); }
});
router.post('/subscriptions', async (req, res, next) => {
  try {
    if (!vapid()) fail('Configura las claves VAPID del servidor para activar las notificaciones.', 503);
    if (!validSubscription(req.body)) fail('La suscripción push no es válida.');
    const { endpoint, keys, expirationTime } = req.body;
    const subscription = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, expirationTime: expirationTime ?? null };
    // One browser subscription belongs to the latest signed-in account, never two accounts.
    const { error } = await supabase.from('push_subscriptions').upsert({ user_id: req.user.id, endpoint, subscription, updated_at: new Date().toISOString() }, { onConflict: 'endpoint' });
    if (error) throw error;
    res.status(201).json({ ok: true });
  } catch (error) { next(error); }
});
router.delete('/subscriptions', async (req, res, next) => {
  try {
    const endpoint = req.body?.endpoint;
    if (!validEndpoint(endpoint)) fail('La suscripción push no es válida.');
    const { error } = await supabase.from('push_subscriptions').delete().eq('user_id', req.user.id).eq('endpoint', endpoint);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) { next(error); }
});
// Call this after committing a confirmed sale, including sales approved by the AI.
// The frontend also calls /sale as a fallback while a session is open.
async function notifySale(userId, conversationId) {
  const config = vapid();
  if (!config) fail('Las notificaciones push aún no están configuradas.', 503);
  if (typeof conversationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) fail('Selecciona una conversación válida.');
  const { data: sale, error: saleError } = await supabase.from('conversations').select('*').eq('user_id', userId).eq('id', conversationId).maybeSingle();
  if (saleError) throw saleError;
  if (!sale) fail('No se encontró esta conversación.', 404);
  if (sale.is_sale !== true) fail('Esta conversación no tiene una venta confirmada.', 409);
  const { data: subscriptions, error } = await supabase.from('push_subscriptions').select('id,endpoint,subscription').eq('user_id', userId);
  if (error) throw error;
  const eventKey = String(sale.id) + ':' + String(sale.sale_at || 'approved');
  const payload = JSON.stringify(notification(sale));
  let sent = 0, skipped = 0, retry = 0;
  for (const device of subscriptions) {
    if (!validSubscription(device.subscription)) { skipped++; continue; }
    const claim = { user_id: userId, event_key: eventKey, endpoint: device.endpoint };
    const claimed = await supabase.from('push_deliveries').insert(claim);
    if (claimed.error?.code === '23505') { skipped++; continue; }
    if (claimed.error) throw claimed.error;
    const owned = await supabase.from('push_subscriptions').select('id').eq('user_id', userId).eq('endpoint', device.endpoint).maybeSingle();
    if (owned.error || !owned.data) {
      await release(claim);
      if (owned.error) throw owned.error;
      skipped++; continue;
    }
    try {
      await webPush.sendNotification(device.subscription, payload, { vapidDetails: config, TTL: 3600, timeout: 10000, urgency: 'normal' });
      sent++;
    } catch (deliveryError) {
      await release(claim);
      if ([404, 410].includes(deliveryError.statusCode)) {
        const removed = await supabase.from('push_subscriptions').delete().eq('user_id', userId).eq('endpoint', device.endpoint);
        if (removed.error) throw removed.error;
        skipped++;
      } else { retry++; }
    }
  }
  return { ok: true, sent, skipped, retry };
}
async function release(claim) {
  const { error } = await supabase.from('push_deliveries').delete().eq('user_id', claim.user_id).eq('event_key', claim.event_key).eq('endpoint', claim.endpoint);
  if (error) throw error;
}
router.post('/sale', async (req, res, next) => {
  try { res.json(await notifySale(req.user.id, req.body?.id)); }
  catch (error) { next(error); }
});
module.exports = router;
module.exports.notifySale = notifySale;
