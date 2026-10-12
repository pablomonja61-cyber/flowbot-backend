const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const plans = require('../services/plans');
const conversationsRouter = require('./conversations');

// ════════════════════════════════════════════════════════════
// Mensajes programados (chat en vivo)
// GET    /api/scheduled-messages?conversation_id=...
// POST   /api/scheduled-messages        { conversation_id, scheduledAt (ISO), repeat, repeatEvery, repeatUnit, messages[] }
// PUT    /api/scheduled-messages/:id    (mismos campos)
// DELETE /api/scheduled-messages/:id
// Un proceso interno revisa cada 30 s y envía lo que ya llegó a su hora.
// ════════════════════════════════════════════════════════════
const UNIDADES = { days: 1, weeks: 7, months: 30 };
const TIPOS = ['text', 'image', 'video', 'audio', 'file', 'sticker'];

function limpiarMensajes(lista) {
  if (!Array.isArray(lista) || !lista.length) return { error: 'Agrega al menos un mensaje' };
  if (lista.length > 20) return { error: 'Máximo 20 mensajes por programación' };
  const out = [];
  for (const m of lista) {
    if (!m || !TIPOS.includes(m.type)) return { error: 'Tipo de mensaje no válido' };
    const item = { type: m.type, text: String(m.text || '').slice(0, 6000), url: '', fileName: String(m.fileName || '').slice(0, 200) };
    if (m.type === 'text') { if (!item.text.trim()) return { error: 'Hay un mensaje de texto vacío' }; }
    else {
      try { const u = new URL(m.url); if (!['http:', 'https:'].includes(u.protocol)) throw 0; item.url = u.href; }
      catch { return { error: 'Falta el archivo o el enlace de un mensaje' }; }
    }
    out.push(item);
  }
  return { messages: out };
}

function leerCuerpo(body) {
  const fecha = new Date(body.scheduledAt || body.run_at);
  if (!Number.isFinite(fecha.getTime())) return { error: 'Fecha no válida' };
  if (fecha.getTime() <= Date.now() + 15000) return { error: 'Elige una fecha y hora futuras' };
  const m = limpiarMensajes(body.messages);
  if (m.error) return { error: m.error };
  const every = Math.max(1, Math.min(365, parseInt(body.repeatEvery) || 1));
  const unit = UNIDADES[body.repeatUnit] ? body.repeatUnit : 'days';
  return { row: { run_at: fecha.toISOString(), repeat: !!body.repeat, repeat_every: every, repeat_unit: unit, messages: m.messages } };
}

function paraFrontend(r) {
  return {
    id: r.id, conversation_id: r.conversation_id, scheduledAt: r.run_at, repeat: r.repeat,
    repeatEvery: String(r.repeat_every), repeatUnit: r.repeat_unit, messages: r.messages,
    status: r.status, last_error: r.last_error, last_run_at: r.last_run_at, runs: r.runs
  };
}

router.get('/', auth, async (req, res, next) => {
  try {
    let q = supabase.from('scheduled_messages').select('*').eq('user_id', req.user.id).order('run_at', { ascending: true }).limit(500);
    if (req.query.conversation_id) q = q.eq('conversation_id', req.query.conversation_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json((data || []).map(paraFrontend));
  } catch (e) { next(e); }
});

router.post('/', auth, plans.requireActive, async (req, res, next) => {
  try {
    const { conversation_id } = req.body || {};
    const l = leerCuerpo(req.body || {});
    if (!conversation_id) return res.status(400).json({ error: 'Falta la conversación' });
    if (l.error) return res.status(400).json({ error: l.error });
    const { data: conv } = await supabase.from('conversations').select('id').eq('id', conversation_id).eq('user_id', req.user.id).maybeSingle();
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });
    const { count } = await supabase.from('scheduled_messages').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('status', 'pending');
    if ((count || 0) >= 500) return res.status(429).json({ error: 'Tienes demasiados mensajes programados pendientes' });
    const { data, error } = await supabase.from('scheduled_messages').insert({ user_id: req.user.id, conversation_id, ...l.row }).select().single();
    if (error) throw error;
    res.status(201).json(paraFrontend(data));
  } catch (e) { next(e); }
});

router.put('/:id', auth, plans.requireActive, async (req, res, next) => {
  try {
    const l = leerCuerpo(req.body || {});
    if (l.error) return res.status(400).json({ error: l.error });
    const { data, error } = await supabase.from('scheduled_messages')
      .update({ ...l.row, status: 'pending', last_error: null, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('user_id', req.user.id).in('status', ['pending', 'failed', 'sent']).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'No se encontró el mensaje programado' });
    res.json(paraFrontend(data));
  } catch (e) { next(e); }
});

router.delete('/:id', auth, async (req, res, next) => {
  try {
    const { error } = await supabase.from('scheduled_messages').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Proceso que envía lo programado ──────────────────────────────
function siguienteFecha(desde, cada, unidad) {
  const paso = cada * UNIDADES[unidad] * 86400000;
  let t = new Date(desde).getTime() + paso;
  while (t <= Date.now()) t += paso; // si el servidor estuvo apagado, no manda todos los atrasados
  return new Date(t).toISOString();
}

let corriendo = false;
async function procesarPendientes() {
  if (corriendo) return;
  corriendo = true;
  try {
    // Libera los que se quedaron "enviando" por un reinicio
    await supabase.from('scheduled_messages').update({ status: 'pending' })
      .eq('status', 'sending').lt('last_run_at', new Date(Date.now() - 10 * 60000).toISOString());
    const { data: vencidos } = await supabase.from('scheduled_messages').select('*')
      .eq('status', 'pending').lte('run_at', new Date().toISOString()).order('run_at').limit(20);
    for (const item of vencidos || []) {
      // Reserva el mensaje para que no se envíe dos veces
      const { data: tomado } = await supabase.from('scheduled_messages')
        .update({ status: 'sending', last_run_at: new Date().toISOString() }).eq('id', item.id).eq('status', 'pending').select('id').maybeSingle();
      if (!tomado) continue;
      let estado = 'sent', error = null;
      try {
        const cuenta = await plans.estadoCuenta(item.user_id);
        if (cuenta.suspended) throw new Error('Cuenta suspendida: renueva tu plan para enviar mensajes');
        const { data: conv } = await supabase.from('conversations').select('*, connections(*)').eq('id', item.conversation_id).maybeSingle();
        if (!conv) throw new Error('La conversación ya no existe');
        if (conv.is_blocked) throw new Error('El chat está bloqueado');
        const resultados = await conversationsRouter.enviarPasos(conv, item.messages || []);
        const fallos = resultados.filter(r => !r.ok);
        if (fallos.length === resultados.length) { estado = 'failed'; error = fallos[0]?.error || 'No se pudo enviar'; }
        else if (fallos.length) error = `Algunos pasos fallaron: ${fallos[0].error}`;
      } catch (e) { estado = 'failed'; error = e.response?.data?.error?.message || e.message; }

      if (item.repeat) {
        await supabase.from('scheduled_messages').update({
          status: 'pending', run_at: siguienteFecha(item.run_at, item.repeat_every, item.repeat_unit),
          last_error: error, last_run_at: new Date().toISOString(), runs: (item.runs || 0) + 1
        }).eq('id', item.id);
      } else {
        await supabase.from('scheduled_messages').update({
          status: estado, last_error: error, last_run_at: new Date().toISOString(), runs: (item.runs || 0) + 1
        }).eq('id', item.id);
      }
    }
  } catch (e) { console.error('[Programados]', e.message); }
  finally { corriendo = false; }
}

function iniciar() {
  setInterval(procesarPendientes, 30 * 1000);
  console.log('⏰ Mensajes programados: revisión cada 30 s');
}

module.exports = router;
module.exports.iniciar = iniciar;
module.exports.procesarPendientes = procesarPendientes;
