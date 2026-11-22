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
const plans = require('../services/plans');
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const axios = require('axios');
const enviosMasivos = require('../services/enviosMasivos');

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
router.post('/send', plans.requireActive, async (req, res, next) => {
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

// ── POST /api/broadcasts ─────────────────────────────────────────
// Crea un envío masivo programado. A diferencia de /send, este no
// manda nada de golpe: guarda la lista de destinatarios y la
// configuración (cuándo empieza, cada cuánto, en qué horario y
// cuántos por día) y el despachador los va mandando uno a uno.
//
// Body: { name?, connection_id, flow_id | template_name+template_language,
//         scheduled_at?, config?, contact_ids: ['id'] | 'all' }
router.post('/', plans.requireActive, async (req, res, next) => {
  try {
    const { name, connection_id, flow_id, template_name, template_language, scheduled_at, config, contact_ids } = req.body;
    if (!connection_id) return res.status(400).json({ error: 'Falta la conexión.' });
    if (!flow_id && !template_name) return res.status(400).json({ error: 'Elige un flujo o una plantilla.' });

    const { data: conn } = await supabase
      .from('connections')
      .select('id, phone_number_id, access_token, connection_type')
      .eq('id', connection_id)
      .eq('user_id', req.user.id)
      .single();
    if (!conn) return res.status(404).json({ error: 'Conexión no encontrada.' });

    // Por la API oficial de WhatsApp no se puede escribir en frío sin
    // una plantilla aprobada: Meta lo rechaza. Mejor avisar aquí.
    const esCloudAPI = !!(conn.phone_number_id && conn.access_token);
    if (flow_id && esCloudAPI) {
      return res.status(400).json({ error: 'Por la API oficial de WhatsApp solo se puede empezar con una plantilla aprobada por Meta. Elige una plantilla, o usa una conexión por QR para mandar un flujo.' });
    }
    if (template_name && !esCloudAPI) {
      return res.status(400).json({ error: 'Las plantillas son de la API oficial. Por QR elige un flujo.' });
    }

    if (flow_id) {
      const { data: flujo } = await supabase.from('flows').select('id, nodes').eq('id', flow_id).eq('user_id', req.user.id).single();
      if (!flujo) return res.status(404).json({ error: 'Flujo no encontrado.' });
      if (!(flujo.nodes || []).some(n => n.type === 'start')) {
        return res.status(400).json({ error: 'Ese flujo no tiene bloque de Inicio.' });
      }
    }

    let q = supabase.from('contacts').select('id, name, phone').eq('user_id', req.user.id);
    if (Array.isArray(contact_ids) && contact_ids.length) q = q.in('id', contact_ids);
    else if (contact_ids !== 'all') return res.status(400).json({ error: 'Elige a quién mandarlo.' });
    const { data: contactos } = await q;
    if (!contactos || !contactos.length) return res.status(400).json({ error: 'No hay contactos para este envío.' });

    const cfg = enviosMasivos.normalizarConfig(config);
    const programado = scheduled_at && new Date(scheduled_at) > new Date();

    const { data: envio, error: errEnvio } = await supabase.from('broadcast_logs').insert({
      user_id: req.user.id,
      connection_id,
      name: (name || '').trim().slice(0, 120) || null,
      flow_id: flow_id || null,
      template_name: template_name || null,
      template_language: template_language || null,
      total_contactos: contactos.length,
      enviados: 0,
      fallidos: 0,
      status: programado ? 'programado' : 'en_progreso',
      scheduled_at: scheduled_at || null,
      next_at: scheduled_at || new Date().toISOString(),
      config: cfg
    }).select().single();
    if (errEnvio) throw errEnvio;

    // Los destinatarios, en lotes para no mandar una consulta enorme.
    const filas = contactos.map(c => ({
      broadcast_id: envio.id, user_id: req.user.id, contact_id: c.id,
      contact_phone: c.phone, contact_name: c.name || c.phone
    }));
    for (let i = 0; i < filas.length; i += 500) {
      const { error } = await supabase.from('broadcast_targets').insert(filas.slice(i, i + 500));
      if (error) throw error;
    }

    console.log(`[Envíos masivos] Creado ${envio.id}: ${contactos.length} contactos, ${programado ? 'programado' : 'empieza ya'}`);
    res.status(201).json(envio);
  } catch (err) { next(err); }
});

// ── PATCH /api/broadcasts/:id ────────────────────────────────────
// Pausar, reanudar o cancelar un envío en curso.
router.patch('/:id', async (req, res, next) => {
  try {
    const accion = req.body.accion;
    const estados = { pausar: 'pausado', reanudar: 'en_progreso', cancelar: 'cancelado' };
    if (!estados[accion]) return res.status(400).json({ error: 'Acción no válida.' });

    const cambio = { status: estados[accion] };
    if (accion === 'reanudar') cambio.next_at = new Date().toISOString();
    if (accion === 'cancelar') cambio.finished_at = new Date().toISOString();

    const { data, error } = await supabase.from('broadcast_logs')
      .update(cambio).eq('id', req.params.id).eq('user_id', req.user.id).select().single();
    if (error || !data) return res.status(404).json({ error: 'Envío no encontrado.' });
    res.json(data);
  } catch (err) { next(err); }
});

// ── GET /api/broadcasts/:id/targets ──────────────────────────────
// A quién se le mandó, a quién no y por qué falló.
router.get('/:id/targets', async (req, res, next) => {
  try {
    const { data: envio } = await supabase.from('broadcast_logs')
      .select('id').eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (!envio) return res.status(404).json({ error: 'Envío no encontrado.' });

    const { data, error } = await supabase.from('broadcast_targets')
      .select('contact_name, contact_phone, status, error, sent_at')
      .eq('broadcast_id', req.params.id)
      .order('sent_at', { ascending: true, nullsFirst: false })
      .limit(1000);
    if (error) throw error;
    res.json(data || []);
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
