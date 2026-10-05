// routes/connectionHealth.js
// GET /api/connection-health  (?force=1 para preguntarle a Meta ya mismo)
// Móntala en index.js con:
//   const connectionHealth = require('./routes/connectionHealth');
//   app.use('/api/connection-health', connectionHealth);
//   connectionHealth.startMonitor();

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const status = require('../services/connectionStatus');

const FRESCO_MS = 60 * 1000;                 // no se pregunta a Meta si se revisó hace menos de 1 min
const REVISION_AUTOMATICA_MS = 3 * 60 * 1000; // red de seguridad: cada 3 min

function paraFrontend(c) {
  const { severity, label } = status.clasificar(c.meta_status);
  return {
    connection_id: c.id,
    name: c.name,
    phone_number: c.phone_number,
    status: c.meta_status || null,
    severity: c.meta_status ? severity : 'unknown',
    label: c.meta_status ? label : 'Sin revisar todavía',
    quality_rating: c.meta_quality || null,
    checked_at: c.meta_status_checked_at || null,
    blocked_since: c.blocked_detected_at || null,
    error: c.meta_status_error || null
  };
}

router.get('/', auth, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { data, error } = await supabase
      .from('connections').select(status.COLUMNAS)
      .eq('user_id', req.user.id).eq('connection_type', 'api');
    if (error) throw error;

    const forzar = req.query.force === '1';
    const ahora = Date.now();
    const lista = await Promise.all((data || []).map(async c => {
      if (!c.phone_number_id || !c.access_token) return c;
      const viejo = !c.meta_status_checked_at || (ahora - new Date(c.meta_status_checked_at).getTime()) > FRESCO_MS;
      return (forzar || viejo) ? status.revisarConexion(c) : c;
    }));
    res.json(lista.map(paraFrontend));
  } catch (err) { next(err); }
});

let monitorIniciado = false;
function startMonitor() {
  if (monitorIniciado) return;
  monitorIniciado = true;
  setTimeout(status.revisarTodas, 45 * 1000);
  const t = setInterval(status.revisarTodas, REVISION_AUTOMATICA_MS);
  if (t.unref) t.unref();
}

module.exports = router;
module.exports.startMonitor = startMonitor;
