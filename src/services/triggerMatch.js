// Decide si un mensaje activa un disparador.
//
// Los disparadores antiguos solo tienen `keyword`; los nuevos pueden traer
// varias `phrases`, el tipo de coincidencia, si distingue mayúsculas y un
// tiempo de espera antes de volver a activarse. Si los campos nuevos no
// están, se comporta exactamente como antes.

const supabase = require('../models/supabase');

/** Todas las frases del disparador (las nuevas y la de siempre). */
function frasesDe(trigger) {
  const lista = Array.isArray(trigger.phrases) ? trigger.phrases : [];
  const todas = [...lista, trigger.keyword]
    .map(f => String(f == null ? '' : f).trim())
    .filter(Boolean);
  return [...new Set(todas)];
}

/** ¿El mensaje coincide con este disparador? (no mira el tiempo de espera) */
function coincide(trigger, mensaje) {
  const texto = String(mensaje || '').trim();
  if (!texto) return false;

  const tipo = trigger.match_type || 'contains';
  if (tipo === 'any') return true;

  const sensible = trigger.case_sensitive === true;
  const m = sensible ? texto : texto.toLowerCase();

  return frasesDe(trigger).some(fraseCruda => {
    const frase = sensible ? fraseCruda : fraseCruda.toLowerCase();
    if (!frase) return false;
    if (frase === '*' || frase === 'default') return false; // el catch-all se trata aparte
    switch (tipo) {
      case 'exact': return m === frase;
      case 'starts_with': return m.startsWith(frase);
      case 'regex':
        try { return new RegExp(fraseCruda, sensible ? '' : 'i').test(texto); }
        catch { return false; }
      case 'contains':
      default: return m === frase || m.includes(frase);
    }
  });
}

/** ¿Es el disparador comodín que atrapa cualquier mensaje? */
function esComodin(trigger) {
  return frasesDe(trigger).some(f => f === '*' || f.toLowerCase() === 'default')
    || trigger.match_type === 'any';
}

/** ¿Puede volver a dispararse para este contacto? Mira "repetible" y la espera. */
async function puedeDispararse(trigger, contactPhone) {
  if (trigger.is_repeatable === false) {
    const { count } = await supabase
      .from('trigger_executions')
      .select('*', { count: 'exact', head: true })
      .eq('trigger_id', trigger.id)
      .eq('contact_phone', contactPhone);
    return !count;
  }
  const espera = Number(trigger.cooldown_seconds) || 0;
  if (espera > 0) {
    const { data } = await supabase
      .from('trigger_executions')
      .select('executed_at')
      .eq('trigger_id', trigger.id)
      .eq('contact_phone', contactPhone)
      .order('executed_at', { ascending: false })
      .limit(1);
    const ultima = data && data[0] && data[0].executed_at;
    if (ultima && (Date.now() - new Date(ultima).getTime()) < espera * 1000) return false;
  }
  return true;
}

/** Busca entre los disparadores el primero que aplica. */
async function buscarDisparador(triggers, mensaje, contactPhone) {
  for (const t of triggers || []) {
    if (esComodin(t)) continue;
    if (!coincide(t, mensaje)) continue;
    if (await puedeDispararse(t, contactPhone)) return t;
  }
  return null;
}

/** El disparador comodín, si hay uno y puede usarse. */
async function buscarComodin(triggers, contactPhone) {
  for (const t of triggers || []) {
    if (!esComodin(t)) continue;
    if (await puedeDispararse(t, contactPhone)) return t;
  }
  return null;
}

module.exports = { coincide, esComodin, puedeDispararse, buscarDisparador, buscarComodin, frasesDe };
