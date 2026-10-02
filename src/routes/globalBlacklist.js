// routes/globalBlacklist.js
// Lista Negra Global — compartida entre TODAS las cuentas de AriaBot.
// Cualquier usuario puede reportar un número por fraude; cada usuario
// decide por su cuenta si quiere activar la protección (nadie queda
// afectado sin haberlo activado). Con la protección activa, un número
// reportado no dispara los flujos automáticos de ESE usuario — pero
// sigue pudiendo escribir y ser atendido manualmente si hace falta.
//
// Móntala en index.js con:
//   app.use('/api/global-blacklist', require('./routes/globalBlacklist'));

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');

router.use(auth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Nunca se devuelve el número completo — se enmascara, dejando solo
// los primeros 4 y los últimos 2 dígitos visibles.
function enmascarar(numero) {
  const limpio = String(numero || '').replace(/\D/g, '');
  if (limpio.length <= 6) return '•'.repeat(limpio.length);
  return limpio.slice(0, 4) + '•'.repeat(limpio.length - 6) + limpio.slice(-2);
}
const normalizar = numero => String(numero || '').replace(/\D/g, '');

// ── GET /api/global-blacklist/status ─────────────────────────
// Si la protección de ESTE usuario está activa, y cuántos números
// hay reportados en total (para la tarjeta de estadísticas).
router.get('/status', async (req, res, next) => {
  try {
    const [{ data: cfg }, { count }] = await Promise.all([
      supabase.from('user_blacklist_settings').select('protection_enabled').eq('user_id', req.user.id).maybeSingle(),
      supabase.from('global_blacklist').select('*', { count: 'exact', head: true })
    ]);
    res.json({ protection_enabled: cfg?.protection_enabled || false, total_reported: count || 0 });
  } catch (err) { next(err); }
});

// ── POST /api/global-blacklist/toggle  { enabled } ───────────
router.post('/toggle', async (req, res, next) => {
  try {
    const enabled = !!req.body?.enabled;
    const { error } = await supabase
      .from('user_blacklist_settings')
      .upsert({ user_id: req.user.id, protection_enabled: enabled, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw error;
    res.json({ success: true, protection_enabled: enabled });
  } catch (err) { next(err); }
});

// ── GET /api/global-blacklist?search=&page=&limit= ───────────
// Lista de números reportados, SIEMPRE enmascarados — nadie puede
// ver el número completo de otra persona, ni siquiera quien reportó.
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 30, search = '' } = req.query;
    const offset = (page - 1) * limit;
    let query = supabase.from('global_blacklist').select('phone_number, report_count, last_reason, first_reported_at', { count: 'exact' });
    if (search) query = query.ilike('phone_number', `%${normalizar(search)}%`);
    const { data, error, count } = await query.order('report_count', { ascending: false }).range(offset, offset + limit - 1);
    if (error) throw error;
    res.json({
      data: (data || []).map(r => ({
        phone_masked: enmascarar(r.phone_number),
        report_count: r.report_count,
        last_reason: r.last_reason,
        first_reported_at: r.first_reported_at
      })),
      total: count, page: +page, limit: +limit
    });
  } catch (err) { next(err); }
});

// ── POST /api/global-blacklist/report  { phone_number, reason, conversation_id? } ──
router.post('/report', async (req, res, next) => {
  try {
    const numero = normalizar(req.body?.phone_number);
    const reason = String(req.body?.reason || '').trim().slice(0, 300) || 'Sin motivo especificado';
    if (numero.length < 6) return res.status(400).json({ error: 'Número inválido.' });

    const { data: existente } = await supabase.from('global_blacklist').select('id, report_count').eq('phone_number', numero).maybeSingle();

    let blacklistId;
    if (existente) {
      blacklistId = existente.id;
    } else {
      const { data: nuevo, error } = await supabase
        .from('global_blacklist')
        .insert({ phone_number: numero, last_reason: reason })
        .select('id').single();
      if (error) throw error;
      blacklistId = nuevo.id;
    }

    // Un mismo usuario no puede reportar 2 veces el mismo número
    // (evita inflar el contador él solo).
    const { error: reporteError } = await supabase
      .from('global_blacklist_reports')
      .insert({ blacklist_id: blacklistId, reported_by: req.user.id, reason });

    if (reporteError) {
      if (reporteError.code === '23505') return res.status(409).json({ error: 'Ya reportaste este número antes.' });
      throw reporteError;
    }

    if (existente) {
      await supabase.from('global_blacklist')
        .update({ report_count: existente.report_count + 1, last_reason: reason, last_reported_at: new Date().toISOString() })
        .eq('id', blacklistId);
    }

    res.status(201).json({ success: true });
  } catch (err) { next(err); }
});

// ── Función interna — la usa webhook.js para saber si debe
// bloquear el disparo de flujos para este número. ────────────
async function estaBloqueado(userId, contactPhone) {
  const numero = normalizar(contactPhone);
  if (!numero) return false;
  const { data: cfg } = await supabase.from('user_blacklist_settings').select('protection_enabled').eq('user_id', userId).maybeSingle();
  if (!cfg?.protection_enabled) return false;
  const { data } = await supabase.from('global_blacklist').select('id').eq('phone_number', numero).maybeSingle();
  return !!data;
}

module.exports = router;
module.exports.estaBloqueado = estaBloqueado;
