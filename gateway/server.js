import express from 'express';
import crypto from 'crypto';
import { PORT } from './src/config.js';
import authRoutes from './src/routes/auth.js';
import invoiceRoutes from './src/routes/invoice.js';
import qrRoutes from './src/routes/qr.js';
import historyRoutes from './src/routes/history.js';
import refundRoutes from './src/routes/refund.js';
import sessionRoutes from './src/routes/session.js';
import { startPolling } from './src/polling.js';
import 'dotenv/config';

const app = express();

app.use(express.json());

// Доступ к API — только с ключом (X-Gateway-Key). Веб-панель отключена.
const GATEWAY_KEY = process.env.GATEWAY_KEY || '';
if (GATEWAY_KEY.length < 24) {
  console.error('GATEWAY_KEY is missing or too short (min 24 chars). Refusing to start.');
  process.exit(1);
}
const keyOk = (k) => {
  const a = Buffer.from(String(k || ''));
  const b = Buffer.from(GATEWAY_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
app.use('/api', (req, res, next) => (keyOk(req.headers['x-gateway-key']) ? next() : res.status(401).json({ error: 'unauthorized' })));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/invoice', invoiceRoutes);
app.use('/api/qr', qrRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/refund', refundRoutes);
app.use('/api/session', sessionRoutes);

app.listen(PORT, () => {
  console.log(`\n  🟢 Kaspi Pay App running at http://localhost:${PORT}\n`);
  startPolling();
});
