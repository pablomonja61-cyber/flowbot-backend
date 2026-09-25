// routes/broadcasts.js
// Envíos masivos — como WhatsApp solo permite escribirle "en frío" a
// alguien (más de 24h sin que te haya escrito) usando una PLANTILLA
// aprobada por Meta, este archivo: 1) trae las plantillas aprobadas
// disponibles, y 2) manda el envío masivo real usando una de ellas.
//
// Requiere: npm install axios (casi seguro ya lo tienes instalado)
//
// Móntala en index.js con:
//   app.use('/api/broadcasts', require('./routes/broadcasts'));

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const axios = require('axios');

router.use(auth);

// ── GET /api/broadcasts/templates?connection_id=... ─────────────
// Trae las plantillas de WhatsApp ya APROBADAS por Meta para esa
// conexión — el usuario solo puede elegir entre estas, no puede
// escribir texto libre (así lo pide WhatsApp para envíos masivos).
router.get('/templates', async (req, res, next) => {
  try {
    const { connection_id } = req.query;
    if (!connection_id) return res.status(400).json({ error: 'Falta connection_id.' });

    const { data: conn, error } = await supabase
      .from('connections')
      .select('waba_id, access_token')
      .eq('id', connection_id)
      .eq('user_id', req.user.id)
      .single();
    if (error || !conn) return res.status(404).json({ error: 'Conexión no encontrada.' });
    if (!conn.waba_id) return res.status(400).json({ error: 'Esta conexión no tiene un WABA vinculado.' });

    const metaRes = await axios.get(
      `https://graph.facebook.com/v21.0/${conn.waba_id}/message_templates`,
      { params: { access_token: conn.access_token, fields: 'name,status,language,category,components', limit: 100 } }
    );

    const aprobadas = (metaRes.data?.data || []).filter(t => t.status === 'APPROVED');
    res.json(aprobadas);
  } catch (err) {
    console.error('[Envíos masivos] Error trayendo plantillas:', err.response?.data || err.message);
    next(err);
  }
});

// ── POST /api/broadcasts/send ────────────────────────────────────
// Manda el envío masivo de verdad. Body esperado:
// { connection_id, template_name, template_language, contact_ids: ['id1','id2'] | 'all' }
router.post('/send', async (req, res, next) => {
  try {
    const { connection_id, template_name, template_language, contact_ids } = req.body;
    if (!connection_id || !template_name || !template_language) {
      return res.status(400).json({ error: 'Faltan connection_id, template_name o template_language.' });
    }

    const { data: conn, error: connError } = await supabase
      .from('connections')
      .select('phone_number_id, access_token')
      .eq('id', connection_id)
      .eq('user_id', req.user.id)
      .single();
    if (connError || !conn) return res.status(404).json({ error: 'Conexión no encontrada.' });

    let query = supabase.from('contacts').select('id, phone').eq('user_id', req.user.id);
    if (contact_ids !== 'all' && Array.isArray(contact_ids) && contact_ids.length > 0) {
      query = query.in('id', contact_ids);
    }
    const { data: contactos, error: contError } = await query;
    if (contError) throw contError;
    if (!contactos || contactos.length === 0) return res.status(400).json({ error: 'No hay contactos para enviar.' });

    const { data: log, error: logError } = await supabase
      .from('broadcast_logs')
      .insert({ user_id: req.user.id, connection_id, template_name, total_contactos: contactos.length, status: 'en_progreso' })
      .select().single();
    if (logError) throw logError;

    // Responde de inmediato — el envío real sigue en segundo plano,
    // porque mandarle a cientos/miles de contactos puede tardar
    // varios minutos y no tiene sentido dejar al usuario esperando.
    res.status(202).json({ success: true, broadcast_id: log.id, total: contactos.length });

    (async () => {
      let enviados = 0, fallidos = 0;
      for (const contacto of contactos) {
        try {
          await axios.post(
            `https://graph.facebook.com/v21.0/${conn.phone_number_id}/messages`,
            {
              messaging_product: 'whatsapp',
              to: contacto.phone,
              type: 'template',
              template: { name: template_name, language: { code: template_language } }
            },
            { headers: { Authorization: `Bearer ${conn.access_token}` }, timeout: 10000 }
          );
          enviados++;
        } catch (e) {
          fallidos++;
          console.error(`[Envíos masivos] Falló para ${contacto.phone}:`, e.response?.data?.error?.message || e.message);
        }
        // Pequeña pausa entre cada envío para no chocar con los
        // límites de velocidad de la API de WhatsApp.
        await new Promise(r => setTimeout(r, 300));
      }
      await supabase.from('broadcast_logs').update({
        enviados, fallidos, status: 'completado', finished_at: new Date().toISOString()
      }).eq('id', log.id);
      console.log(`[Envíos masivos] Terminado (${log.id}): ${enviados} enviados, ${fallidos} fallidos.`);
    })();
  } catch (err) { next(err); }
});

// ── GET /api/broadcasts ──────────────────────────────────────────
// Historial de envíos masivos — para ver el progreso/resultado.
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('broadcast_logs')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (err) { next(err); }
});

module.exports = router;
