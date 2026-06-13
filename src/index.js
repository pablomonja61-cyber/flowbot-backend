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
const mediaRoutes = require('./routes/media');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Seguridad y utilidades ──────────────────────────────────
app.use(helmet());
app.use(morgan('combined'));
app.use(cors({
  origin: [process.env.FRONTEND_URL, 'http://localhost:5173'],
  credentials: true
}));

// ── Body parser ─────────────────────────────────────────────
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.raw({ type: 'multipart/form-data', limit: '50mb' }));

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
app.use('/api/media', mediaRoutes);

// ── Error handler global ────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Error interno del servidor'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend corriendo en puerto ${PORT}`);
  console.log(`📡 Webhook: POST /webhook/whatsapp`);
  console.log(`🔐 Auth:    POST /api/auth/register | /api/auth/login`);
  console.log(`📁 Media:   POST /api/media/upload | GET /api/media`);
});

module.exports = app;