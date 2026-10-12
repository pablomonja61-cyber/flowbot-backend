const supabase = require('../models/supabase');

// ════════════════════════════════════════════════════════════
// Prevención de baneo — regulación automática de seguimientos
// Reglas (solo si la conexión tiene activada la regulación):
//  • Conexión nueva (menos de 14 días): modo protegido → máximo 1 seguimiento SIN respuesta del cliente.
//  • Después: si ya hay datos suficientes (≥ 20 seguimientos enviados) y responden menos del 5 %,
//    también se limita a 1 seguimiento sin respuesta. Si responden bien, no se limita.
// "Sin respuesta" = seguimientos enviados después del último mensaje del cliente.
// ════════════════════════════════════════════════════════════
const DIAS_PROTEGIDO = 14;
const MIN_MUESTRA = 20;
const TASA_MINIMA = 0.05;
const cache = new Map(); // connectionId → { t, stats }

async function estadisticas(connectionId) {
  const hit = cache.get(connectionId);
  if (hit && Date.now() - hit.t < 60000) return hit.stats;
  const { data: enviados } = await supabase.from('scheduled_followups')
    .select('conversation_id, send_at').eq('connection_id', connectionId).eq('status', 'sent')
    .order('send_at', { ascending: false }).limit(1000);
  const lista = enviados || [];
  let respondidos = 0;
  if (lista.length) {
    const ids = [...new Set(lista.map(f => f.conversation_id))].slice(0, 400);
    const minFecha = lista.reduce((m, f) => (f.send_at < m ? f.send_at : m), lista[0].send_at);
    const { data: entrantes } = await supabase.from('messages').select('conversation_id, created_at')
      .in('conversation_id', ids).eq('direction', 'inbound').gte('created_at', minFecha).limit(20000);
    const porConv = {};
    for (const m of entrantes || []) (porConv[m.conversation_id] ||= []).push(new Date(m.created_at).getTime());
    for (const f of lista) {
      const t = new Date(f.send_at).getTime();
      if ((porConv[f.conversation_id] || []).some(x => x > t)) respondidos++;
    }
  }
  const stats = { sent: lista.length, answered: respondidos, rate: lista.length ? Math.round(respondidos / lista.length * 1000) / 10 : null };
  cache.set(connectionId, { t: Date.now(), stats });
  return stats;
}

function enModoProtegido(conn) {
  const edad = (Date.now() - new Date(conn.created_at).getTime()) / 86400000;
  return conn.followup_regulation_enabled !== false && edad < DIAS_PROTEGIDO;
}

// ¿Se puede enviar este seguimiento programado? → { ok, reason }
async function permitir(item) {
  try {
    if (!item.connection_id) return { ok: true };
    const { data: conn } = await supabase.from('connections').select('id, created_at, followup_regulation_enabled').eq('id', item.connection_id).maybeSingle();
    if (!conn || conn.followup_regulation_enabled === false) return { ok: true };

    let limitado = enModoProtegido(conn);
    if (!limitado) {
      const s = await estadisticas(conn.id);
      limitado = s.sent >= MIN_MUESTRA && s.answered / s.sent < TASA_MINIMA;
    }
    if (!limitado) return { ok: true };

    // Seguimientos ya enviados en esta conversación después del último mensaje del cliente
    const { data: ult } = await supabase.from('messages').select('created_at')
      .eq('conversation_id', item.conversation_id).eq('direction', 'inbound').order('created_at', { ascending: false }).limit(1).maybeSingle();
    let q = supabase.from('scheduled_followups').select('id', { count: 'exact', head: true })
      .eq('conversation_id', item.conversation_id).eq('status', 'sent');
    if (ult?.created_at) q = q.gt('send_at', ult.created_at);
    const { count } = await q;
    if ((count || 0) >= 1) return { ok: false, reason: 'Regulación de seguimientos: máx. 1 sin respuesta' };
    return { ok: true };
  } catch (e) {
    console.error('[FollowupGuard]', e.message);
    return { ok: true }; // ante un error, no se frena el envío
  }
}

module.exports = { permitir, estadisticas, enModoProtegido, DIAS_PROTEGIDO };
