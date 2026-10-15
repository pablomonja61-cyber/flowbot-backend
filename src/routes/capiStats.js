const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { metricasPorNumero, eventosDeNumero } = require('../services/capiMetrics');

router.use(auth);

// GET /api/capi-metrics?range=today|yesterday|7d|30d   (o from=YYYY-MM-DD&to=YYYY-MM-DD)
// Devuelve todos los números (API y QR) con sus métricas, y el total.
router.get('/', async (req, res, next) => {
  try { res.json(await metricasPorNumero(req.user.id, req.query)); } catch (err) { next(err); }
});

// GET /api/capi-metrics/:connectionId/events?page=1&limit=25&status=all|sent|rejected|pending|no_click
// "Eventos enviados" de ese pixel: tarjetas (hoy / 7 días / 30 días / total), gráfico de 30 días y tabla de ventas.
router.get('/:connectionId/events', async (req, res, next) => {
  try {
    const r = await eventosDeNumero(req.user.id, req.params.connectionId, req.query);
    if (!r) return res.status(404).json({ error: 'Conexión no encontrada.' });
    res.json(r);
  } catch (err) { next(err); }
});

// GET /api/capi-metrics/:connectionId?range=...  → solo ese número
router.get('/:connectionId', async (req, res, next) => {
  try {
    const r = await metricasPorNumero(req.user.id, req.query);
    const n = r.numbers.find(x => x.connection_id === req.params.connectionId);
    if (!n) return res.status(404).json({ error: 'Conexión no encontrada.' });
    res.json({ range: r.range, from: r.from, to: r.to, ...n });
  } catch (err) { next(err); }
});

module.exports = router;
