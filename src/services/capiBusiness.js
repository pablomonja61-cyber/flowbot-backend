const axios = require('axios');
const crypto = require('crypto');
const supabase = require('../models/supabase');

// ════════════════════════════════════════════════════════════
// Meta CAPI Business — "Rastrear Compras ADS (Meta)"
// Envía la compra confirmada a Meta (Conversions API de mensajería) para las conexiones
// elegidas en el proyecto (WhatsApp QR / números que anuncian desde una página de Facebook).
// ════════════════════════════════════════════════════════════
const GRAPH_VERSION = 'v26.0';

async function proyectoDeConexion(userId, connectionId) {
  const { data } = await supabase.from('capi_business_projects').select('*')
    .eq('user_id', userId).contains('connection_ids', [connectionId]).limit(1).maybeSingle();
  return data || null;
}

// Devuelve true si la conexión pertenece a un proyecto Business (y por tanto ya se atendió aquí).
async function enviarCompra(userId, conversation, saleAmount) {
  if (!conversation?.connection_id) return false;
  const proyecto = await proyectoDeConexion(userId, conversation.connection_id);
  if (!proyecto) return false;

  const guardarEstado = async (estado) => {
    await supabase.from('conversations').update({ meta_event_status: String(estado).slice(0, 500) }).eq('id', conversation.id);
    await supabase.from('capi_business_projects').update({ last_status: String(estado).slice(0, 300), last_event_at: new Date().toISOString() }).eq('id', proyecto.id);
  };

  try {
    if (!conversation.ctwa_clid) {
      // Meta solo puede atribuir la compra a un anuncio si la persona entró por un anuncio "Enviar mensaje"
      await guardarEstado('omitido: la conversación no vino de un anuncio (sin ctwa_clid)');
      console.log(`[CAPI Business] Conversación ${conversation.id} sin ctwa_clid — no se envía`);
      return true;
    }
    const { data: cfg } = await supabase.from('ads_config').select('currency').eq('user_id', userId).maybeSingle();
    const currency = cfg?.currency || 'PEN';
    const evento = {
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      event_id: 'purchase_' + conversation.id,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { page_id: proyecto.page_id, ctwa_clid: conversation.ctwa_clid },
      custom_data: { currency, value: parseFloat(saleAmount) || 0 }
    };
    // Teléfono con hash (ayuda a Meta a coincidir al cliente)
    const tel = String(conversation.contact_phone || '').replace(/\D/g, '');
    if (tel && !/^[A-Z]{2}\./.test(conversation.contact_phone || '')) evento.user_data.ph = [crypto.createHash('sha256').update(tel).digest('hex')];

    await axios.post(`https://graph.facebook.com/${GRAPH_VERSION}/${proyecto.dataset_id}/events`,
      { data: [evento], partner_agent: 'ariabot', access_token: proyecto.access_token }, { timeout: 10000 });
    await guardarEstado('enviado');
    console.log(`[CAPI Business] ✓ Compra enviada (dataset ${proyecto.dataset_id}, ${currency} ${saleAmount})`);
  } catch (err) {
    const detalle = JSON.stringify(err.response?.data?.error || { message: err.message });
    console.error('[CAPI Business] Error enviando evento:', detalle);
    await guardarEstado(`error: ${detalle}`).catch(() => {});
  }
  return true;
}

module.exports = { enviarCompra, proyectoDeConexion, GRAPH_VERSION };
