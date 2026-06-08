import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import onrampRoutes from './routes/onramp.routes';
import offrampRoutes from './routes/offramp.routes';
import ratesRoutes from './routes/rates.routes';
import webhookRoutes from './routes/webhook.routes';
import fireblocksRoutes from './routes/fireblocks.routes';
import transferRoutes from './routes/transfer.routes';
import quoteRoutes from './routes/quote.routes';
import simulateRoutes from './routes/simulate.routes';
import orchestratorRoutes from './routes/orchestrator.routes';
import demoRoutes from './routes/demo.routes';
import path from 'path';

dotenv.config();

// Fail fast on missing required env vars before accepting any traffic
const REQUIRED_ENV = ['DATABASE_URL', 'API_BASE_URL'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[startup] Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}
const PLACEHOLDER = ['your_', 'YOUR_'];
const placeholders = ['FIREBLOCKS_API_KEY', 'B2BINPAY_CLIENT_ID', 'B2BINPAY_CLIENT_SECRET', 'FIREBLOCKS_TREASURY_VAULT']
  .filter(k => { const v = process.env[k] ?? ''; return !v || PLACEHOLDER.some(p => v.startsWith(p)); });
if (placeholders.length) {
  console.warn(`[startup] WARNING: these env vars are unset or placeholder: ${placeholders.join(', ')}`);
}

const app = express();
const PORT = process.env.PORT || 4000;

// Capture raw body for webhook HMAC/signature verification, then parse JSON
app.use(express.json({
  verify: (req: Request & { rawBody?: string }, _res, buf) => {
    req.rawBody = buf.toString();
  },
} as Parameters<typeof express.json>[0]));

// Health — reachable at both / and /api for reverse-proxy compat
app.get(['/health', '/api/health'], (_req, res) => {
  res.json({
    status: 'ok',
    service: 'fincruise-settlement',
    timestamp: new Date().toISOString(),
    sandbox: process.env.B2BINPAY_SANDBOX === 'true',
    callbackBase: process.env.API_BASE_URL,
  });
});

app.get(['/', '/api'], (_req, res) => {
  const base = process.env.API_BASE_URL ?? `http://localhost:${PORT}/api`;
  res.json({
    message: 'FinCruse Settlement API',
    version: '1.0.0',
    callbackUrls: {
      b2binpay: `${base}/webhooks/b2binpay`,
      fireblocks: `${base}/webhooks/fireblocks`,
    },
    routes: {
      onramp: `${base}/onramp/deposit`,
      offramp: [`${base}/offramp/estimate`, `${base}/offramp/payout`],
      rates: `${base}/rates?symbols=BTC,USDT`,
      fireblocks: {
        vaults: `${base}/fireblocks/vaults`,
        transfer: `${base}/fireblocks/transfer`,
        estimateFee: `${base}/fireblocks/estimate-fee`,
        networkFee: `${base}/fireblocks/network-fee?assetId=ETH`,
        assets: `${base}/fireblocks/assets`,
      },
    },
  });
});

// All routes under /api prefix
app.use('/api/onramp', onrampRoutes);
app.use('/api/offramp', offrampRoutes);
app.use('/api/rates', ratesRoutes);
app.use('/api/fireblocks', fireblocksRoutes);
// Serve visual flow page — no-cache so browser always gets latest
app.get('/monitor', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use('/api/simulate', simulateRoutes);
app.use('/api/orchestrator', orchestratorRoutes);
app.use('/api/demo', demoRoutes);
app.get('/demo', (_req, res) => { res.setHeader('Cache-Control','no-store'); res.sendFile(path.join(__dirname,'../public/demo.html')); });
app.use('/api/quote', quoteRoutes);
app.use('/api', transferRoutes);
app.use('/api/webhooks', webhookRoutes);

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Settlement service running on http://localhost:${PORT}`);
  console.log(`Public callback base: ${process.env.API_BASE_URL ?? '(not set)'}`);
  console.log(`B2BinPay mode: ${process.env.B2BINPAY_SANDBOX === 'true' ? 'SANDBOX' : 'PRODUCTION'}`);
});
