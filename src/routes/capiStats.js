const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { metricasPorNumero } = require('../services/capiMetrics');

router.use(auth);

// GET /api/capi-metrics?range=today|yesterday|7d|30d   (o from=YYYY-MM-DD&to=YYYY-MM-DD)
// Devuelve todos los números (API y QR) con sus métricas, y el total.
router.get('/', async (req, res, next) => {
  try { res.json(await metricasPorNumero(req.user.id, req.query)); } catch (err) { next(err); }
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
