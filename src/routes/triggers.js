const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');
const { traerTodo } = require('../services/dbPaginado');
router.use(auth);
// ── GET /api/triggers ────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('triggers')
      .select('*, flows(name)')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});
// ── GET /api/triggers/stats ──────────────────────────────────
// "Disparos del mes": cuántas veces se activaron tus disparadores en el mes actual (hora de Lima),
// comparado con el mes anterior, con el detalle por disparador y por día.
router.get('/stats', async (req, res, next) => {
  try {
    const OFFSET = 5 * 3600e3; // Lima = UTC-5
    const lima = new Date(Date.now() - OFFSET);
    const y = lima.getUTCFullYear(), m = lima.getUTCMonth();
    const inicioMes = new Date(Date.UTC(y, m, 1) + OFFSET);
    const inicioSig = new Date(Date.UTC(y, m + 1, 1) + OFFSET);
    const inicioAnt = new Date(Date.UTC(y, m - 1, 1) + OFFSET);
    const diasMes = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const diaHoy = lima.getUTCDate();

    const { data: disp, error } = await supabase.from('triggers').select('id, name, keyword, is_active, flow_id, connection_id, flows(name)').eq('user_id', req.user.id);
    if (error) throw error;
    const ids = (disp || []).map(d => d.id);
    const nombreMes = new Intl.DateTimeFormat('es', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m, 1)));

    let ejecuciones = [];
    if (ids.length) {
      // Del mes anterior hasta hoy (para el comparativo), y el total histórico por conteo
      for (let i = 0; i < ids.length; i += 100) {
        const lote = ids.slice(i, i + 100);
        const filas = await traerTodo(() => supabase.from('trigger_executions').select('id, trigger_id, executed_at')
          .in('trigger_id', lote).gte('executed_at', inicioAnt.toISOString()).lt('executed_at', inicioSig.toISOString()).order('id'));
        ejecuciones = ejecuciones.concat(filas);
      }
    }
    const totales = {}, ultimo = {};
    await Promise.all((disp || []).map(async d => {
      const [{ count }, { data: ult }] = await Promise.all([
        supabase.from('trigger_executions').select('id', { count: 'exact', head: true }).eq('trigger_id', d.id),
        supabase.from('trigger_executions').select('executed_at').eq('trigger_id', d.id).order('executed_at', { ascending: false }).limit(1)
      ]);
      totales[d.id] = count || 0; ultimo[d.id] = ult?.[0]?.executed_at || null;
    }));

    const dia = ms => new Date(ms - OFFSET).toISOString().slice(0, 10);
    const serie = [];
    const porDia = {};
    for (let d = 1; d <= diasMes; d++) {
      const f = new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
      porDia[f] = { fecha: f, disparos: 0 }; serie.push(porDia[f]);
    }
    const mesPorTrigger = {};
    let mesActual = 0, mesAnterior = 0;
    for (const e of ejecuciones) {
      const t = new Date(e.executed_at).getTime();
      if (t >= inicioMes.getTime()) {
        mesActual++;
        mesPorTrigger[e.trigger_id] = (mesPorTrigger[e.trigger_id] || 0) + 1;
        const f = porDia[dia(t)]; if (f) f.disparos++;
      } else mesAnterior++;
    }
    const variacion = mesAnterior > 0 ? Number((((mesActual - mesAnterior) / mesAnterior) * 100).toFixed(1)) : null;

    res.json({
      mes: {
        etiqueta: nombreMes, desde: inicioMes.toISOString(), hasta: inicioSig.toISOString(),
        disparos: mesActual, mes_anterior: mesAnterior, variacion_porcentaje: variacion,
        promedio_diario: Number((mesActual / Math.max(diaHoy, 1)).toFixed(1)), dias_transcurridos: diaHoy, dias_del_mes: diasMes
      },
      total_historico: Object.values(totales).reduce((a, b) => a + b, 0),
      disparadores: { total: (disp || []).length, activos: (disp || []).filter(d => d.is_active).length },
      serie_mes: serie,
      por_disparador: (disp || []).map(d => ({
        trigger_id: d.id, nombre: d.name, palabra_clave: d.keyword, activo: !!d.is_active, flujo: d.flows?.name || null, connection_id: d.connection_id,
        disparos_mes: mesPorTrigger[d.id] || 0, disparos_total: totales[d.id] || 0, ultimo_disparo: ultimo[d.id] || null
      })).sort((a, b) => b.disparos_mes - a.disparos_mes)
    });
  } catch (err) { next(err); }
});

// ── POST /api/triggers ───────────────────────────────────────
// Body: { name, keyword, flow_id, connection_id, is_repeatable, tag }
router.post('/', async (req, res, next) => {
  try {
    const { name, keyword, flow_id, connection_id, is_repeatable = true, tag } = req.body;
    if (!name || !keyword || !flow_id || !connection_id) {
      return res.status(400).json({ error: 'name, keyword, flow_id y connection_id son requeridos' });
    }
    // Verificar que el flujo pertenece al usuario
    const { data: flow } = await supabase
      .from('flows')
      .select('id')
      .eq('id', flow_id)
      .eq('user_id', req.user.id)
      .single();
    if (!flow) return res.status(404).json({ error: 'Flujo no encontrado' });
    const { data, error } = await supabase
      .from('triggers')
      .insert({
        id: uuidv4(),
        user_id: req.user.id,
        name,
        keyword: keyword.toLowerCase().trim(),
        flow_id,
        connection_id,
        is_repeatable,
        is_active: true,
        tag: tag || null
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});
// ── PUT /api/triggers/:id ────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const { name, keyword, flow_id, is_active, is_repeatable, tag, connection_id } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name;
    if (keyword !== undefined) updates.keyword = keyword.toLowerCase().trim();
    if (flow_id !== undefined) updates.flow_id = flow_id;
    if (is_active !== undefined) updates.is_active = is_active;
    if (is_repeatable !== undefined) updates.is_repeatable = is_repeatable;
    if (tag !== undefined) updates.tag = tag;
    // Permite reasignar el disparador a otra conexión de WhatsApp —
    // necesario para cuando se borró la conexión original y el
    // disparador quedó "huérfano" (connection_id en null), así se
    // puede volver a activar apuntándolo a la conexión nueva.
    if (connection_id !== undefined) updates.connection_id = connection_id;
    const { data, error } = await supabase
      .from('triggers')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: 'Trigger no encontrado' });
    res.json(data);
  } catch (err) { next(err); }
});
// ── DELETE /api/triggers/:id ─────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('triggers')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});
module.exports = router;
