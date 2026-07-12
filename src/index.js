require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const webhookRoutes = require('./routes/webhook');
const authRoutes = require('./routes/auth');
const flowRoutes = require('./routes/flows');
const triggerRoutes = require('./routes/triggers');
const connectionRoutes = require('./routes/connections');
const conversationRoutes = require('./routes/conversations');
const qrConnectionRoutes = require('./routes/qrConnections');
const { restoreActiveSessions } = require('./services/baileys');
const analyticsRoutes = require('./routes/analytics');
const aiConfigRoutes = require('./routes/aiConfig');
const paymentConfigRoutes = require('./routes/paymentConfig');
const mediaRoutes = require('./routes/media');
const remarketingRoutes = require('./routes/remarketing');
const adsConfigRoutes = require('./routes/adsConfig');
const adsMetricsRoutes = require('./routes/adsMetrics');
const app = express();
const PORT = process.env.PORT || 3000;
// ── Seguridad y utilidades ──────────────────────────────────
app.use(helmet());
app.use(morgan('combined'));
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:5173',
    'https://ventas-vista.lovable.app'
  ],
  credentials: true
}));
// ── Body parser ─────────────────────────────────────────────
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.raw({ type: 'multipart/form-data', limit: '100mb' }));
// ── Health check ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// ── Rutas ───────────────────────────────────────────────────
app.use('/webhook', webhookRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/flows', flowRoutes);
app.use('/api/triggers', triggerRoutes);
app.use('/api/connections', connectionRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/qr-connections', qrConnectionRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ai-config', aiConfigRoutes);
app.use('/api/payment-config', paymentConfigRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/remarketing', remarketingRoutes);
app.use('/api/ads-config', adsConfigRoutes);
app.use('/api/ads-metrics', adsMetricsRoutes);
// ── Error handler global ────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Error interno del servidor'
  });
});
setTimeout(() => restoreActiveSessions(), 3000);
app.listen(PORT, () => {
  console.log(`🚀 Backend corriendo en puerto ${PORT}`);
  console.log(`📡 Webhook: POST /webhook/whatsapp`);
  console.log(`🔐 Auth:    POST /api/auth/register | /api/auth/login`);
  console.log(`📁 Media:   POST /api/media/upload | GET /api/media`);
  console.log(`📢 Remarketing: GET/POST /api/remarketing`);
});
module.exports = app;
