import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import transferRoutes    from './routes/transfer.routes';
import quoteRoutes       from './routes/quote.routes';
import simulateRoutes    from './routes/simulate.routes';
import orchestratorRoutes from './routes/orchestrator.routes';
import webhookRoutes     from './routes/webhook.routes';
import brainrockRoutes   from './routes/brainrock.routes';
import darajaRoutes      from './routes/daraja.routes';
import choicebankRoutes  from './routes/choicebank.routes';

dotenv.config();

// Register liquidity providers — must run after dotenv so credentials are loaded
import('./services/lp-bootstrap');

// Start Kafka validation consumer — gates every payment before ledger write
import('./services/payment-validator.service').then(m => m.startPaymentValidator()).catch(err =>
  console.error('[startup] Payment validator failed to start:', err)
);

// Fail fast on missing required env vars
const REQUIRED_ENV = ['DATABASE_URL', 'API_BASE_URL'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[startup] Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const PLACEHOLDER = ['your_', 'YOUR_'];
const placeholders = [
  'FIREBLOCKS_API_KEY', 'B2BINPAY_CLIENT_ID', 'B2BINPAY_CLIENT_SECRET',
  'FIREBLOCKS_TREASURY_VAULT', 'BRAINROCK_API_KEY', 'BRAINROCK_TREASURY_ACCOUNT_ID',
  'CHOICE_BANK_API_KEY', 'DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET',
].filter(k => { const v = process.env[k] ?? ''; return !v || PLACEHOLDER.some(p => v.startsWith(p)); });
if (placeholders.length) {
  console.warn(`[startup] Sandbox mode — unset credentials: ${placeholders.join(', ')}`);
}

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json({
  verify: (req: Request & { rawBody?: string }, _res, buf) => {
    req.rawBody = buf.toString();
  },
} as Parameters<typeof express.json>[0]));

// Health
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
    service: 'FinCruse Settlement API — AxLink Network',
    version: '2.0.0',
    settlement: 'USDT (Fireblocks / Solana) — internal, users see local fiat only',
    callbackUrls: {
      b2binpay:       `${base}/webhooks/b2binpay`,
      fireblocks:     `${base}/webhooks/fireblocks`,
      brainrock:      `${base}/webhooks/brainrock`,
      choicebank:     `${base}/webhooks/choicebank`,
      daraja_b2c:     `${base}/webhooks/daraja/b2c/result`,
      daraja_timeout: `${base}/webhooks/daraja/b2c/timeout`,
      daraja_stk:     `${base}/webhooks/daraja/stk`,
    },
  });
});

// Core API
app.use('/api', transferRoutes);
app.use('/api/quote', quoteRoutes);
app.use('/api/simulate', simulateRoutes);
app.use('/api/orchestrator', orchestratorRoutes);

// Webhooks — inbound callbacks from rails and custody
app.use('/api/webhooks', webhookRoutes);
app.use('/api/webhooks', brainrockRoutes);
app.use('/api/webhooks', darajaRoutes);
app.use('/api/webhooks', choicebankRoutes);

// Global error handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const msg = err instanceof Error ? err.message : String(err);

  // Payment validation rejections return 422, not 500
  if (err && typeof err === 'object' && (err as Record<string, unknown>).code === 'PAYMENT_REJECTED') {
    res.status(422).json({ error: msg, code: 'PAYMENT_REJECTED' });
    return;
  }

  if (err && typeof err === 'object' && 'errors' in err) {
    const agg = err as { errors: unknown[] };
    agg.errors.forEach((e, i) => console.error(`  [${i}]`, e instanceof Error ? e.message : String(e)));
  } else {
    console.error('[Error]', msg, err instanceof Error ? err.stack : '');
  }
  res.status(500).json({ error: msg || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`FinCruse Settlement running on http://localhost:${PORT}`);
  console.log(`AxLink network · B2BinPay mode: ${process.env.B2BINPAY_SANDBOX === 'true' ? 'SANDBOX' : 'PRODUCTION'}`);
});
