/* Salida por inactividad de los bloques que esperan respuesta.
 *
 * El Menú, el Template y el bloque Esperar respuesta dejan el flujo
 * parado hasta que el cliente escribe. Si nunca escribe, el flujo se
 * quedaba ahí para siempre y la salida "Sin respuesta" que se ve en el
 * editor no servía de nada.
 *
 * Este reloj revisa cada minuto qué conversaciones llevan esperando más
 * de lo configurado y las saca por esa salida.
 */

const supabase = require('../models/supabase');
const bloques = require('./bloquesFlujo');

const DOS_DIAS = 2 * 24 * 3600;

/** Cuánto aguanta este bloque antes de darse por vencido (en segundos). */
function esperaDelBloque(nodo) {
  const d = nodo.data || {};
  if (d.forever === true) return 0;              // nunca se rinde
  const s = Number(d.timeout_seconds) || 0;
  if (s > 0) return s;
  // El menú y el carrusel, si no pones tiempo, usan dos días (como Meta).
  return ['menu', 'carousel', 'template'].includes(nodo.type) ? DOS_DIAS : 0;
}

async function revisarUna(conv) {
  const { data: flujo } = await supabase.from('flows')
    .select('id, nodes, edges').eq('id', conv.current_flow_id).maybeSingle();
  if (!flujo) return;
  const nodo = (flujo.nodes || []).find(n => n.id === conv.current_node_id);
  if (!nodo) return;

  const espera = esperaDelBloque(nodo);
  if (!espera) return;
  const parado = (Date.now() - new Date(conv.flow_paused_at).getTime()) / 1000;
  if (parado < espera) return;

  const destino = bloques.siguientePorSalida(flujo, nodo.id, 'timeout');
  // Pase lo que pase, el flujo deja de estar parado aquí.
  await supabase.from('conversations')
    .update({ current_node_id: null, current_flow_id: null, flow_paused_at: null })
    .eq('id', conv.id);

  if (!destino) {
    console.log(`[Espera] ${conv.contact_phone} no respondió a "${nodo.type}" y esa salida no está conectada: el flujo termina`);
    return;
  }

  const { data: con } = await supabase.from('connections')
    .select('*').eq('id', conv.connection_id).maybeSingle();
  if (!con) return;

  try {
    if (con.connection_type === 'qr') {
      const { executeFlowBaileys, activeSessions } = require('./baileys');
      const sesion = activeSessions[con.id];
      if (!sesion || !sesion.sock) {
        console.log('[Espera] La conexión por QR no está activa ahora mismo; se intentará más tarde');
        return;
      }
      const jid = conv.last_jid || (String(conv.contact_phone).replace(/\D/g, '') + '@s.whatsapp.net');
      await executeFlowBaileys(flujo.id, sesion.sock, jid, conv.contact_phone, '', conv.id, destino);
    } else {
      const { executeFlow } = require('./flowEngine');
      await executeFlow(flujo.id, conv.contact_phone, '', con, conv.id, destino);
    }
    console.log(`[Espera] ${conv.contact_phone} no respondió a "${nodo.type}": el flujo sigue por la salida de inactividad`);
  } catch (e) {
    console.error('[Espera] No se pudo continuar el flujo:', e.message);
  }
}

async function tick() {
  try {
    const { data: paradas } = await supabase.from('conversations')
      .select('id, connection_id, contact_phone, last_jid, current_flow_id, current_node_id, flow_paused_at')
      .not('current_node_id', 'is', null)
      .not('flow_paused_at', 'is', null)
      .eq('flow_active', true)
      .limit(200);
    for (const c of (paradas || [])) await revisarUna(c);
  } catch (e) {
    console.error('[Espera] Error revisando los flujos parados:', e.message);
  }
}

function arrancar(cada = 60000) {
  setInterval(tick, cada);
  console.log('[Espera] Reloj de salidas por inactividad en marcha');
}

module.exports = { arrancar, tick, esperaDelBloque };
