const express = require('express');
const router = express.Router();
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');
const plans = require('../services/plans');

// ════════════════════════════════════════════════════════════
// POST /webhook/hotmart — recibe las notificaciones de Hotmart
// cada vez que hay una compra aprobada, reembolso, cancelación, etc.
// Esto es lo que le da a /api/auth/register la información real de
// quién compró de verdad, para no dejar crear cuentas gratis.
//
// Nota: la ruta /webhook ya tiene un middleware global que lee el
// body "crudo" (Buffer), no como JSON parseado — es lo que necesita
// webhook.js para WhatsApp. Por eso acá también hay que parsear el
// body manualmente con JSON.parse(), en vez de usar express.json().
// ════════════════════════════════════════════════════════════

// HOTMART_OFFERS (variable de Railway): JSON que traduce el código de oferta de Hotmart
// a lo que activa. Ejemplo:
// {"abc123":{"plan":"p19"},"def456":{"plan":"p39"},"ghi789":{"extra":"api"},"jkl012":{"extra":"warmup"}}
function ofertas() { try { return JSON.parse(process.env.HOTMART_OFFERS || '{}'); } catch { return {}; } }

async function aplicarOrden(orden, usuario) {
  const regla = ofertas()[orden.offer_code];
  if (!regla || !usuario) return false;
  const aprobada = orden.status === 'approved';
  if (regla.plan) {
    if (aprobada) await plans.activarPlan(usuario.id, regla.plan);
    else {
      await supabase.from('users').update({ subscription_expires_at: new Date().toISOString() }).eq('id', usuario.id);
      plans.limpiarCache(usuario.id);
    }
  } else if (regla.extra) {
    const col = { api: 'extra_api', qr: 'extra_qr', warmup: 'extra_warmup' }[regla.extra];
    if (!col) return false;
    const qty = Math.max(1, parseInt(regla.qty) || 1);
    const { data: u } = await supabase.from('users').select(col).eq('id', usuario.id).maybeSingle();
    const nuevo = Math.max(0, (u?.[col] || 0) + (aprobada ? qty : -qty));
    await supabase.from('users').update({ [col]: nuevo }).eq('id', usuario.id);
    plans.limpiarCache(usuario.id);
  } else return false;
  await supabase.from('hotmart_orders').update({ applied_user_id: usuario.id, applied_at: new Date().toISOString() }).eq('transaction', orden.transaction);
  return true;
}

// Aplica compras aprobadas que llegaron antes de que la persona se registrara.
async function aplicarComprasPendientes(usuario) {
  try {
    const { data } = await supabase.from('hotmart_orders').select('*').eq('email', usuario.email.toLowerCase()).eq('status', 'approved').is('applied_at', null);
    for (const o of data || []) await aplicarOrden(o, usuario);
  } catch (e) { console.error('[Hotmart] aplicarComprasPendientes:', e.message); }
}

router.post('/hotmart', async (req, res) => {
  try {
    const hottokRecibido = req.headers['x-hotmart-hottok'];
    if (!hottokRecibido || hottokRecibido !== process.env.HOTMART_HOTTOK) {
      console.warn('[Hotmart] Webhook con hottok inválido — ignorado');
      return res.status(401).json({ error: 'hottok inválido' });
    }

    let body;
    try {
      body = JSON.parse(req.body.toString());
    } catch (e) {
      console.warn('[Hotmart] Body no es JSON válido');
      return res.status(200).json({ received: true });
    }

    const { event, data } = body || {};
    const email = (data?.buyer?.email || '').toLowerCase().trim();

    if (!email) {
      console.warn('[Hotmart] Webhook sin email de comprador — ignorado');
      return res.status(200).json({ received: true });
    }

    const eventosAprobados = ['PURCHASE_APPROVED', 'PURCHASE_COMPLETE'];
    const eventosDesaprobados = ['PURCHASE_CANCELED', 'PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK', 'PURCHASE_EXPIRED', 'PURCHASE_PROTEST'];

    let status = null;
    if (eventosAprobados.includes(event)) status = 'approved';
    else if (eventosDesaprobados.includes(event)) status = 'refunded';

    if (!status) {
      console.log(`[Hotmart] Evento "${event}" ignorado (no afecta el acceso)`);
      return res.status(200).json({ received: true });
    }

    const { data: existing } = await supabase
      .from('hotmart_purchases')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      await supabase.from('hotmart_purchases').update({
        status,
        event,
        transaction: data?.purchase?.transaction || null,
        updated_at: new Date().toISOString()
      }).eq('id', existing.id);
    } else {
      await supabase.from('hotmart_purchases').insert({
        id: uuidv4(),
        email,
        status,
        event,
        transaction: data?.purchase?.transaction || null,
        product_id: data?.product?.id ? String(data.product.id) : null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }

    // Orden individual (idempotente por transacción) y activación del plan/extra
    const transaccion = data?.purchase?.transaction;
    const oferta = data?.purchase?.offer?.code || null;
    if (transaccion) {
      const { data: previa } = await supabase.from('hotmart_orders').select('status,applied_at').eq('transaction', transaccion).maybeSingle();
      const yaAplicada = previa && previa.status === status && previa.applied_at;
      if (!yaAplicada) {
        const orden = { transaction: transaccion, email, offer_code: oferta, status, kind: ofertas()[oferta]?.plan ? 'plan' : (ofertas()[oferta]?.extra ? 'extra' : null), detail: { event, recurrence: data?.purchase?.recurrence_number || null } };
        await supabase.from('hotmart_orders').upsert(orden, { onConflict: 'transaction' });
        const { data: usuario } = await supabase.from('users').select('id,email').eq('email', email).maybeSingle();
        if (usuario) await aplicarOrden(orden, usuario);
        else if (oferta && !ofertas()[oferta]) console.warn(`[Hotmart] Oferta sin configurar en HOTMART_OFFERS: ${oferta}`);
      }
    }

    console.log(`[Hotmart] ${email} → ${status} (evento: ${event})`);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Hotmart] Error procesando webhook:', err.message);
    res.status(200).json({ received: true, error: true });
  }
});

module.exports = router;
module.exports.aplicarComprasPendientes = aplicarComprasPendientes;
