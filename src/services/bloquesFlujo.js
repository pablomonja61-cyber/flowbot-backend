/* Bloques de flujo compartidos por los dos motores.
 *
 * El panel dejaba muchos bloques que se veían bien en el lienzo pero que
 * ningún motor sabía ejecutar: al llegar a ellos el flujo seguía de largo
 * sin hacer nada. Aquí vive la lógica de todos esos bloques, una sola vez,
 * para que se comporten igual por la API oficial que por QR.
 *
 * Cada motor le pasa un `canal` con sus funciones de envío, así este
 * archivo no sabe nada de Meta ni de Baileys.
 *
 *   ejecutarBloque(nodo, ctx, canal) → { hecho, handle, pausar, fin }
 *
 *   hecho   : false si el bloque no es de los de aquí (el motor sigue como antes)
 *   handle  : por qué salida continuar ('success', 'true', 'o123'…); vacío = la de siempre
 *   pausar  : deja el flujo esperando al cliente
 *   fin     : termina el flujo
 */

const axios = require('axios');
const supabase = require('../models/supabase');

/* ── Utilidades ─────────────────────────────────────────────── */

const dormir = ms => new Promise(r => setTimeout(r, ms));

/** "1.234,56" / "49,90" / "97" → número. Vacío o raro → null. */
function aNumero(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const coma = s.lastIndexOf(','), punto = s.lastIndexOf('.');
  if (coma > punto) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const UNIDADES = { s: 1, seconds: 1, segundos: 1, m: 60, minutes: 60, minutos: 60, h: 3600, hours: 3600, horas: 3600, d: 86400, days: 86400, dias: 86400 };

/** Acepta 90, "90", [2,'hours'] o {value:2,unit:'hours'} → segundos. */
function aSegundos(v, porDefecto = 0) {
  if (v == null) return porDefecto;
  if (typeof v === 'number') return Math.max(0, Math.round(v));
  if (Array.isArray(v)) return Math.max(0, Math.round((Number(v[0]) || 0) * (UNIDADES[v[1]] || 1)));
  if (typeof v === 'object') return Math.max(0, Math.round((Number(v.value) || 0) * (UNIDADES[v.unit] || 1)));
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : porDefecto;
}

/** Solo direcciones públicas: un bloque no puede apuntar a la red interna. */
function urlExternaPermitida(url) {
  if (!url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return false;
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 127 || a === 0 || a === 10 || a === 169 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  if (host === '::1' || host.startsWith('fd') || host.startsWith('fe80')) return false;
  return true;
}

/** Lee los ajustes del usuario (con su revisión, por si hay que escribir). */
async function leerAjustes(userId) {
  const { data } = await supabase.from('user_settings').select('data').eq('user_id', userId).maybeSingle();
  return data?.data || {};
}

async function guardarAjustes(userId, datos) {
  await supabase.from('user_settings').update({ data: datos }).eq('user_id', userId);
}

/** El contacto guardado (para campos personalizados). */
async function buscarContacto(userId, telefono) {
  const solo = String(telefono || '').replace(/\D/g, '');
  if (!solo) return null;
  const { data } = await supabase.from('contacts')
    .select('id, custom_fields, tags, email')
    .eq('user_id', userId)
    .in('phone', [telefono, '+' + solo, solo])
    .limit(1);
  return (data && data[0]) || null;
}

/* ── Condiciones del bloque Condicional ─────────────────────── */

/** Reúne una sola vez todo lo que las condiciones pueden preguntar. */
async function estadoParaCondiciones(ctx) {
  const { data: conv } = await supabase.from('conversations')
    .select('id, tags, status, assigned_to, contact_name, contact_phone, last_message_at, updated_at')
    .eq('id', ctx.conversationId).maybeSingle();
  const contacto = await buscarContacto(ctx.userId, ctx.contactPhone);
  let zona = 'America/Lima';
  try {
    const aj = await leerAjustes(ctx.userId);
    zona = aj?.settingsData?.company?.timezone || zona;
  } catch { /* si no hay ajustes, se usa la de siempre */ }
  // La hora local del negocio, no la del servidor.
  let local = new Date();
  try { local = new Date(new Date().toLocaleString('en-US', { timeZone: zona })); } catch { }
  // Última vez que escribió el cliente, para la ventana de 24 h.
  const { data: ultimo } = await supabase.from('messages')
    .select('created_at').eq('conversation_id', ctx.conversationId)
    .eq('direction', 'inbound').order('created_at', { ascending: false }).limit(1);
  return {
    texto: String(ctx.userMessage || ''),
    conv: conv || {},
    contacto,
    local,
    ultimoEntrante: ultimo && ultimo[0] ? new Date(ultimo[0].created_at) : null
  };
}

/** Compara un valor con el operador que eligió el usuario. */
function comparar(valor, op, esperado) {
  const a = String(valor ?? '').trim().toLowerCase();
  const b = String(esperado ?? '').trim().toLowerCase();
  switch (op) {
    case 'any': return a !== '';
    case 'eq': return a === b;
    case 'neq': return a !== b;
    case 'nhas': return !a.includes(b);
    case 'starts': return a.startsWith(b);
    case 'gt': case 'lt': case 'gte': case 'lte': case 'neq_n': {
      const x = aNumero(a), y = aNumero(b);
      if (x === null || y === null) return false;
      return op === 'gt' ? x > y : op === 'lt' ? x < y : op === 'gte' ? x >= y : op === 'lte' ? x <= y : x === y;
    }
    default: return a.includes(b);
  }
}

function evaluarCondicion(c, e) {
  const k = String(c.kind || 'message');

  if (k === 'message') return comparar(e.texto, c.op || 'has', c.val);

  if (k === 'tag') {
    const tiene = (e.conv.tags || []).some(t => String(t).toLowerCase() === String(c.tag || '').toLowerCase());
    return c.rule === 'neq' ? !tiene : tiene;
  }
  if (k === 'dow') return e.local.getDay() === Number(c.day);
  if (k === 'hour') {
    const h = e.local.getHours() + e.local.getMinutes() / 60;
    return c.rule === 'after' ? h >= Number(c.hour || 0) : h < Number(c.hour || 0);
  }
  if (k === 'date') {
    if (!c.date) return false;
    const limite = new Date(c.date + 'T00:00:00');
    return c.rule === 'after' ? e.local >= limite : e.local < limite;
  }
  if (k === 'w24') {
    const abierta = !!e.ultimoEntrante && (Date.now() - e.ultimoEntrante.getTime()) < 24 * 3600 * 1000;
    return c.open === false ? !abierta : abierta;
  }
  if (k === 'st_wait') return e.conv.status === 'open';
  if (k === 'st_on') return e.conv.status === 'active';
  if (k === 'st_done') return e.conv.status === 'closed';
  if (k === 'agent') return (c.agents || []).some(a => String(a) === String(e.conv.assigned_to || ''));

  if (k.startsWith('f:')) {
    const campo = k.slice(2);
    const v = campo === 'name' ? e.conv.contact_name
      : campo === 'phone' ? e.conv.contact_phone
        : (e.contacto && e.contacto.email) || '';
    return comparar(v, c.op || 'has', c.val);
  }
  if (k.startsWith('cf:')) {
    const nombre = k.slice(3);
    const campos = (e.contacto && e.contacto.custom_fields) || [];
    const campo = Array.isArray(campos) ? campos.find(x => x && String(x.name).toLowerCase() === nombre.toLowerCase()) : null;
    return comparar(campo ? campo.value : '', c.op || 'has', c.val);
  }
  return false;
}

/* ── Bloques ────────────────────────────────────────────────── */

const TIPOS = new Set([
  'menu', 'template', 'carousel', 'pix', 'copy_button', 'department', 'field_op',
  'ticket', 'pixel', 'payment', 'call', 'kie', 'country', 'access', 'sheets',
  'antiban', 'ordery',
  // los que antes solo existían en la API oficial
  'condition', 'tag', 'label', 'wait', 'chat_status', 'kanban', 'sale', 'http', 'split'
]);

const esBloqueCompartido = tipo => TIPOS.has(tipo);

async function ejecutarBloque(nodo, ctx, canal) {
  const tipo = nodo.type;
  if (!TIPOS.has(tipo)) return { hecho: false };
  const d = nodo.data || {};
  const { userId, conversationId, contactPhone, userMessage, flowId } = ctx;

  switch (tipo) {

    /* ── Menú: lista o botones, y el flujo espera la elección ── */
    case 'menu': {
      const opciones = (d.options || d.opciones || []).filter(o => o && (o.title || o.titulo));
      const cuerpo = d.body || d.text || d.message || '';
      if (!opciones.length) {
        if (cuerpo) await canal.texto(cuerpo);
        return { hecho: true };
      }
      const titulos = opciones.map(o => String(o.title || o.titulo).slice(0, 24));
      const modo = d.mode === 'buttons' || opciones.length <= 3 && d.mode !== 'list' ? 'buttons' : 'list';

      if (modo === 'buttons' && opciones.length <= 3) {
        const cabecera = d.image ? { type: 'image', url: d.image } : null;
        await canal.botones(cuerpo, titulos, { header: cabecera, footer: d.footer || '' });
      } else if (canal.lista) {
        await canal.lista(cuerpo, d.button || 'Ver opciones', opciones.map(o => ({
          id: 'op_' + (o.id || o.title), title: String(o.title || o.titulo).slice(0, 24), description: String(o.description || o.desc || '').slice(0, 72)
        })), { footer: d.footer || '' });
      } else {
        await canal.texto(cuerpo + '\n\n' + titulos.map((t, i) => `${i + 1}. ${t}`).join('\n'));
      }

      // El flujo se queda esperando: la respuesta decide la salida.
      await supabase.from('conversations').update({
        current_flow_id: flowId, current_node_id: nodo.id, flow_active: true, flow_paused_at: new Date().toISOString()
      }).eq('id', conversationId);
      return { hecho: true, pausar: true };
    }

    /* ── Template de Meta: solo por la API oficial ────────────── */
    case 'template': {
      const nombre = d.template_name || d.name || '';
      if (!nombre) { console.warn('[Bloque] Template sin nombre'); return { hecho: true, handle: 'fail' }; }
      if (!canal.plantilla) {
        console.warn('[Bloque] Los templates de Meta no existen en una conexión por QR; se omite');
        return { hecho: true, handle: 'fail' };
      }
      try {
        await canal.plantilla(nombre, d.language || d.template_language || 'es');
      } catch (e) {
        console.error('[Bloque] No se pudo enviar el template:', e.message);
        return { hecho: true, handle: 'fail' };
      }
      await supabase.from('conversations').update({
        current_flow_id: flowId, current_node_id: nodo.id, flow_active: true, flow_paused_at: new Date().toISOString()
      }).eq('id', conversationId);
      return { hecho: true, pausar: true };
    }

    /* ── Carrusel: WhatsApp no lo tiene fuera de los templates, así
          que se manda tarjeta por tarjeta y los botones al final. ── */
    case 'carousel': {
      const tarjetas = (d.cards || []).filter(Boolean);
      if (d.intro) await canal.texto(d.intro);
      for (const t of tarjetas) {
        if (t.image) await canal.imagen(t.image, t.text || '');
        else if (t.text) await canal.texto(t.text);
        await dormir(900);
      }
      const respuestas = [];
      for (const t of tarjetas) for (const b of (t.buttons || [])) if ((b.type || 'reply') === 'reply' && b.title) respuestas.push(b.title);
      if (respuestas.length) {
        await canal.botones(d.pregunta || 'Elige una opción:', respuestas.slice(0, 3), {});
        await supabase.from('conversations').update({
          current_flow_id: flowId, current_node_id: nodo.id, flow_active: true, flow_paused_at: new Date().toISOString()
        }).eq('id', conversationId);
        return { hecho: true, pausar: true };
      }
      return { hecho: true };
    }

    /* ── Botón PIX: se manda la clave para copiar ─────────────── */
    case 'pix': {
      const clave = d.key || '';
      if (!clave) return { hecho: true };
      const partes = [];
      if (d.text) partes.push(d.text);
      if (d.amount) partes.push(`Importe: R$ ${d.amount}`);
      if (d.name) partes.push(`A nombre de: ${d.name}`);
      partes.push(clave);
      if (d.image) await canal.imagen(d.image, d.text || '');
      await canal.texto(partes.join('\n'));
      return { hecho: true };
    }

    /* ── Botón copiar: igual, texto + lo que hay que copiar ──── */
    case 'copy_button': {
      const cuerpo = d.body || d.text || '';
      const copiar = d.copy || '';
      if (cuerpo) await canal.texto(cuerpo);
      if (copiar) await canal.texto(copiar);
      return { hecho: true };
    }

    /* ── Departamento: se guarda en la conversación ───────────── */
    case 'department': {
      const dep = d.departmentId || d.dep || null;
      if (dep) {
        await supabase.from('conversations').update({ department_id: dep }).eq('id', conversationId);
        console.log('[Bloque] Chat asignado al departamento', dep);
      }
      return { hecho: true };
    }

    /* ── Ticket: el chat pasa a un agente del equipo ──────────── */
    case 'ticket': {
      const quien = d.assignee || d.who || '';
      if (quien) {
        await supabase.from('conversations')
          .update({ assigned_to: quien, status: 'active' })
          .eq('id', conversationId);
        console.log('[Bloque] Chat asignado a', quien);
      }
      return { hecho: true };
    }

    /* ── Manipulador: guarda o calcula un campo del contacto ──── */
    case 'field_op': {
      const campo = String(d.field || d.var || '').trim();
      if (!campo) return { hecho: true };
      const op = d.op || 'set_value';
      const crudo = await canal.variables(String(d.value ?? d.val ?? ''));
      const contacto = await buscarContacto(userId, contactPhone);
      if (!contacto) { console.warn('[Bloque] Manipulador: el contacto no está guardado todavía'); return { hecho: true }; }
      const campos = Array.isArray(contacto.custom_fields) ? [...contacto.custom_fields] : [];
      const i = campos.findIndex(c => c && String(c.name).toLowerCase() === campo.toLowerCase());
      let valor;
      if (op === 'set_value') {
        valor = crudo;
      } else {
        const antes = aNumero(i >= 0 ? campos[i].value : 0) || 0;
        const con = aNumero(crudo) || 0;
        valor = String(op === 'add' ? antes + con : op === 'sub' ? antes - con
          : op === 'mul' ? antes * con : op === 'div' ? (con === 0 ? antes : antes / con) : antes);
      }
      if (i >= 0) campos[i] = { ...campos[i], value: valor };
      else campos.push({ name: campo, value: valor });
      await supabase.from('contacts').update({ custom_fields: campos }).eq('id', contacto.id);
      console.log(`[Bloque] Campo "${campo}" del contacto → ${valor}`);
      return { hecho: true };
    }

    /* ── Código de país: separa por el prefijo del número ─────── */
    case 'country': {
      const solo = String(contactPhone || '').replace(/\D/g, '');
      const lista = (d.codes || d.list || []).map(c => typeof c === 'string'
        ? { code: String(c).replace(/\D/g, '') }
        : { code: String(c.code || c.cd || '').replace(/\D/g, '') }).filter(c => c.code);
      // Gana el prefijo más largo que coincida: +51 antes que +5.
      const mejor = lista.filter(c => solo.startsWith(c.code)).sort((a, b) => b.code.length - a.code.length)[0];
      return { hecho: true, handle: mejor ? 'c' + mejor.code : 'otros' };
    }

    /* ── Dar acceso: marca la entrega del producto ────────────── */
    case 'access': {
      await supabase.from('conversations').update({
        access_granted_at: new Date().toISOString()
      }).eq('id', conversationId);
      const texto = d.message || d.text || '';
      if (texto) await canal.texto(texto);
      return { hecho: true };
    }

    /* ── Google Sheets / OrderyPro / AntiBaneo: necesitan una
          cuenta conectada que todavía no existe. Se avisa en el
          log y el flujo sigue, en vez de romperse. ───────────── */
    case 'sheets':
    case 'ordery':
    case 'antiban': {
      console.warn(`[Bloque] "${tipo}" todavía no tiene su integración conectada; el flujo sigue de largo`);
      return { hecho: true };
    }

    /* ── Llamada: WhatsApp no deja llamar desde la API ────────── */
    case 'call': {
      console.warn('[Bloque] WhatsApp no permite iniciar llamadas desde el bot; el flujo sigue');
      return { hecho: true };
    }

    /* ── Pixel: evento de compra a Meta (Conversions API) ─────── */
    case 'pixel': {
      try {
        const { data: conv } = await supabase.from('conversations').select('*').eq('id', conversationId).maybeSingle();
        const capi = require('./capiBusiness');
        if (conv && typeof capi.enviarEvento === 'function') {
          await capi.enviarEvento(userId, conv, {
            evento: d.event === 'Lead' ? 'Lead' : 'Purchase',
            valor: aNumero(await canal.variables(String(d.value || ''))) || 0,
            moneda: d.currency || 'PEN'
          });
          console.log('[Bloque] Evento enviado al pixel');
        } else {
          console.warn('[Bloque] No hay pixel configurado para este evento');
        }
      } catch (e) { console.error('[Bloque] No se pudo enviar el evento del pixel:', e.message); }
      return { hecho: true };
    }

    /* ── Pago por pasarela: solo si hay credenciales guardadas ── */
    case 'payment': {
      const ajustes = await leerAjustes(userId);
      const integraciones = ajustes?.settingsData?.integrations || [];
      const pasarela = String(d.gateway || d.gw || '').toLowerCase();
      const cred = integraciones.find(i => i && String(i.prov || '').toLowerCase() === pasarela && i.active !== false);
      if (!cred) {
        console.warn(`[Bloque] Pago: no hay credenciales de "${pasarela || 'la pasarela'}" en Integraciones`);
        return { hecho: true, handle: 'error' };
      }
      // Con credenciales, el cobro lo genera la pasarela. Mientras tanto se
      // avisa por el log y se sale por "error" para que el flujo tenga a
      // dónde ir en vez de quedarse mudo.
      console.warn('[Bloque] Pago: la pasarela está registrada pero su cobro automático aún no está activo');
      return { hecho: true, handle: 'error' };
    }

    /* ── Kie.ai: genera audio/imagen/video si hay clave ───────── */
    case 'kie': {
      const ajustes = await leerAjustes(userId);
      const integraciones = ajustes?.settingsData?.integrations || [];
      const cred = integraciones.find(i => i && String(i.prov || '').toLowerCase() === 'kie' && i.active !== false);
      const clave = cred && (cred.key || cred.token);
      if (!clave) {
        console.warn('[Bloque] Kie.ai: falta la clave en Integraciones');
        return { hecho: true, handle: 'failure' };
      }
      try {
        const r = await axios.post('https://api.kie.ai/api/v1/generate', {
          model: d.kind === 'video' ? 'veo' : d.kind === 'music' ? 'suno' : d.kind === 'audio' ? 'elevenlabs' : 'image',
          prompt: await canal.variables(String(d.prompt || ''))
        }, { headers: { Authorization: `Bearer ${clave}` }, timeout: 60000, validateStatus: () => true });
        const url = r.data && (r.data.url || (r.data.data && r.data.data.url));
        if (r.status >= 400 || !url) { console.error('[Bloque] Kie.ai respondió', r.status); return { hecho: true, handle: 'failure' }; }
        if (d.kind === 'audio' || d.kind === 'music') await canal.audio(url);
        else if (d.kind === 'video') await canal.video(url, '');
        else await canal.imagen(url, '');
        return { hecho: true, handle: 'success' };
      } catch (e) {
        console.error('[Bloque] Kie.ai falló:', e.message);
        return { hecho: true, handle: 'failure' };
      }
    }

    /* ── Condicional: una o varias reglas ─────────────────────── */
    case 'condition': {
      const reglas = Array.isArray(d.conditions) && d.conditions.length
        ? d.conditions
        : [{ kind: 'message', op: ({ contains: 'has', equals: 'eq', exact: 'eq', starts_with: 'starts', not_contains: 'nhas' })[d.operator || 'contains'] || 'has', val: d.value || '' }];
      const estado = await estadoParaCondiciones(ctx);
      const resultados = reglas.map(r => evaluarCondicion(r, estado));
      const ok = d.mode === 'any' ? resultados.some(Boolean) : resultados.every(Boolean);
      console.log(`[Bloque] Condicional (${d.mode === 'any' ? 'alguna' : 'todas'}): ${ok ? 'se cumple' : 'no se cumple'}`);
      return { hecho: true, handle: ok ? 'true' : 'false' };
    }

    /* ── Etiquetas: añadir y quitar ───────────────────────────── */
    case 'tag':
    case 'label': {
      const poner = [...(d.add || []), ...(d.tag ? [d.tag] : [])].map(String).filter(Boolean);
      const quitar = (d.remove || []).map(String).filter(Boolean);
      if (!poner.length && !quitar.length) return { hecho: true };
      const { data: conv } = await supabase.from('conversations').select('tags').eq('id', conversationId).maybeSingle();
      const actuales = Array.isArray(conv?.tags) ? conv.tags : [];
      const final = [...new Set([...actuales, ...poner])].filter(t => !quitar.includes(t));
      await supabase.from('conversations').update({ tags: final }).eq('id', conversationId);
      // El contacto guarda las suyas aparte: se dejan iguales.
      const contacto = await buscarContacto(userId, contactPhone);
      if (contacto) {
        const suyas = Array.isArray(contacto.tags) ? contacto.tags : [];
        const nuevas = [...new Set([...suyas, ...poner])].filter(t => !quitar.includes(t));
        await supabase.from('contacts').update({ tags: nuevas }).eq('id', contacto.id);
      }
      console.log(`[Bloque] Etiquetas +${poner.length} −${quitar.length}`);
      return { hecho: true };
    }

    /* ── Esperar respuesta ────────────────────────────────────── */
    case 'wait': {
      if (d.message) await canal.texto(d.message);
      await supabase.from('conversations').update({
        current_flow_id: flowId, current_node_id: nodo.id, flow_active: true, flow_paused_at: new Date().toISOString()
      }).eq('id', conversationId);
      return { hecho: true, pausar: true };
    }

    /* ── Controlador de chat ──────────────────────────────────── */
    case 'chat_status': {
      const pedido = String(d.status || '').toLowerCase();
      const mapa = { espera: 'open', waiting: 'open', open: 'open', atencion: 'active', active: 'active', resuelto: 'closed', resueltos: 'closed', closed: 'closed' };
      const estado = mapa[pedido];
      if (estado) {
        const cambios = { status: estado };
        if (estado === 'closed') cambios.finished_at = new Date().toISOString();
        await supabase.from('conversations').update(cambios).eq('id', conversationId);
        console.log(`[Bloque] Chat movido a "${estado}"`);
      }
      return { hecho: true };
    }

    /* ── Kanban: añadir o quitar la tarjeta del lead ──────────── */
    case 'kanban': {
      const columna = d.columnId || d.column || d.col || null;
      const tablero = d.boardId || d.board || null;
      const accion = d.action || d.act || 'create';
      try {
        const datos = await leerAjustes(userId);
        const sd = datos.settingsData || {};
        const kanban = { ...(sd.kanban || {}) };
        const poner = (obj) => {
          const o = { ...(obj || {}) };
          if (accion === 'remove') delete o[conversationId];
          else if (columna) o[conversationId] = columna;
          return o;
        };
        if (tablero && Array.isArray(kanban.boards)) {
          kanban.boards = kanban.boards.map(b => b.id === tablero ? { ...b, assignments: poner(b.assignments) } : b);
        } else {
          kanban.assignments = poner(kanban.assignments);
        }
        kanban.updatedAt = Date.now();
        await guardarAjustes(userId, { ...datos, settingsData: { ...sd, kanban } });
        console.log(`[Bloque] Kanban: ${accion === 'remove' ? 'quitado' : 'movido a ' + columna}`);
      } catch (e) { console.error('[Bloque] No se pudo tocar el Kanban:', e.message); }
      return { hecho: true };
    }

    /* ── Venta aprobada ───────────────────────────────────────── */
    case 'sale': {
      const monto = aNumero(await canal.variables(String(d.amount ?? d.monto ?? '')));
      const cliente = (await canal.variables(String(d.client || ''))).trim();
      const cambios = { is_sale: true, sale_at: new Date().toISOString(), sale_closed_by: 'flow' };
      if (monto && monto > 0) cambios.sale_amount = monto;
      if (d.currency) cambios.sale_currency = String(await canal.variables(String(d.currency))).slice(0, 8);
      if (d.product) cambios.sale_product = d.product;
      if (cliente && !/[{}]/.test(cliente)) cambios.sale_client = cliente;
      await supabase.from('conversations').update(cambios).eq('id', conversationId);
      console.log('[Bloque] Venta registrada desde el flujo');
      return { hecho: true };
    }

    /* ── Integración HTTP ─────────────────────────────────────── */
    case 'http': {
      const url = String(d.url || '').trim();
      if (!urlExternaPermitida(url)) {
        console.warn('[Bloque] URL no permitida en Integración:', url);
        return { hecho: true, handle: 'failure' };
      }
      try {
        const metodo = String(d.method || 'POST').toUpperCase();
        const cabeceras = { 'Content-Type': 'application/json', ...(d.headers || {}) };
        const cuerpo = d.body === undefined
          ? { phone: contactPhone, message: userMessage, conversation_id: conversationId }
          : d.body;
        const r = await axios({
          method: metodo, url, headers: cabeceras,
          data: metodo === 'GET' ? undefined : cuerpo,
          params: metodo === 'GET' ? cuerpo : undefined,
          timeout: 10000, maxRedirects: 0, validateStatus: () => true
        });
        console.log(`[Bloque] Integración ${metodo} ${url} → ${r.status}`);
        return { hecho: true, handle: r.status < 400 ? 'success' : 'failure' };
      } catch (e) {
        console.error('[Bloque] Falló la integración:', e.message);
        return { hecho: true, handle: 'failure' };
      }
    }

    /* ── Distribuidor ─────────────────────────────────────────── */
    case 'split': {
      const salidas = (ctx.flow.edges || []).filter(e => e.source === nodo.id);
      if (!salidas.length) return { hecho: true, fin: true };
      const pesos = d.weights || {};
      const total = salidas.reduce((a, e) => a + (Number(pesos[e.sourceHandle || e.id]) || 1), 0);
      let tirada = Math.random() * total;
      let elegida = salidas[salidas.length - 1];
      for (const e of salidas) {
        tirada -= (Number(pesos[e.sourceHandle || e.id]) || 1);
        if (tirada <= 0) { elegida = e; break; }
      }
      return { hecho: true, handle: elegida.sourceHandle || null, destino: elegida.target || null };
    }
  }

  return { hecho: false };
}

/* ── Salidas ────────────────────────────────────────────────── */

// Un mismo camino se llamó de varias formas con el tiempo.
const ALIAS = {
  true: ['true', 'yes', 'si', 'sí'],
  false: ['false', 'no'],
  success: ['success', 'ok', 'exito', 'éxito'],
  failure: ['failure', 'fail', 'error'],
  fail: ['fail', 'failure', 'error'],
  error: ['error', 'failure', 'fail'],
  main: ['main', 'default', ''],
  otros: ['otros', 'other', 'default']
};

/**
 * De qué nodo sigue el flujo. Si la salida pedida no está conectada y el
 * bloque solo tiene una salida suelta, se usa esa (flujos antiguos).
 * Si no hay nada, el flujo termina ahí en vez de seguir por donde no toca.
 */
function siguientePorSalida(flow, nodeId, handle) {
  const salidas = (flow.edges || []).filter(e => e.source === nodeId);
  if (!salidas.length) return null;
  if (!handle) {
    const suelta = salidas.find(e => !e.sourceHandle || e.sourceHandle === 'default' || e.sourceHandle === 'main');
    return (suelta || salidas[0]).target || null;
  }
  const nombres = ALIAS[handle] || [handle];
  const exacta = salidas.find(e => nombres.includes(e.sourceHandle || ''));
  if (exacta) return exacta.target || null;
  if (salidas.length === 1 && !salidas[0].sourceHandle) return salidas[0].target || null;
  return null;
}

/** Al volver el cliente: por qué salida sigue un bloque que quedó esperando. */
function salidaAlReanudar(nodo, respuesta) {
  const d = nodo.data || {};
  const texto = String(respuesta || '').toLowerCase().trim();
  const limpio = texto.replace(/[^a-z0-9áéíóúñ ]/g, '').trim();
  const parecido = (titulo) => {
    const t = String(titulo || '').toLowerCase().replace(/[^a-z0-9áéíóúñ ]/g, '').trim();
    return t && (limpio === t || limpio.includes(t) || t.includes(limpio));
  };

  if (nodo.type === 'menu') {
    const opciones = d.options || d.opciones || [];
    let i = -1;
    const num = limpio.match(/^(\d+)/);
    if (num) { const n = parseInt(num[1], 10) - 1; if (n >= 0 && n < opciones.length) i = n; }
    if (i === -1) i = opciones.findIndex(o => parecido(o.title || o.titulo));
    if (i === -1) return null;
    return 'o' + (opciones[i].id || opciones[i].title);
  }

  if (nodo.type === 'template') return 'reply';

  if (nodo.type === 'carousel') {
    for (const t of (d.cards || [])) {
      for (const b of (t.buttons || [])) {
        if ((b.type || 'reply') === 'reply' && parecido(b.title)) return 'b' + (b.id || b.title);
      }
    }
    return 'fallback';
  }

  if (nodo.type === 'wait') return 'main';
  return null;
}

module.exports = {
  ejecutarBloque, esBloqueCompartido, siguientePorSalida, salidaAlReanudar,
  aNumero, aSegundos, urlExternaPermitida
};
