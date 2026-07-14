const express = require('express');
const router = express.Router();
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');

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

    console.log(`[Hotmart] ${email} → ${status} (evento: ${event})`);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Hotmart] Error procesando webhook:', err.message);
    res.status(200).json({ received: true, error: true });
  }
});

module.exports = router;
