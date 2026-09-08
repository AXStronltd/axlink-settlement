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
import networkRoutes     from './routes/network.routes';
import treasuryRoutes   from './routes/treasury.routes';
import depositRoutes    from './routes/deposit.routes';
import settlementRoutes from './routes/settlement.routes';

dotenv.config();

// Register liquidity providers (B2BinPay, Brainrock FX, AxLink internal)
import('./bootstrap/lp.bootstrap');

// Register BaaS fiat delivery providers (Daraja, ChoiceBank, Brainrock rails, Thunes…)
import('./bootstrap/baas.bootstrap');

// Start Kafka validation consumer — gates every payment before ledger write
import('./core/payment-validator.service').then(m => m.startPaymentValidator()).catch(err =>
  console.error('[startup] Payment validator failed to start:', err)
);

// Settlement resume worker — drives stalled settlement legs forward after a
// crash or a partner outage. Without it, a settlement that stops between the
// customer debit and the partner payout stays stopped until a human notices.
if (process.env.SETTLEMENT_WORKER_ENABLED !== 'false') {
  import('./core/settlement/resume.worker').then(m => m.startResumeWorker()).catch(err =>
    console.error('[startup] Settlement resume worker failed to start:', err)
  );
}

// Outbox worker — at-least-once delivery of member-bank webhooks.
if (process.env.OUTBOX_WORKER_ENABLED !== 'false') {
  import('./core/outbox.service').then(m => m.startOutboxWorker()).catch(err =>
    console.error('[startup] Outbox worker failed to start:', err)
  );
}


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

// User-initiated Add Funds — must be before /api (transferRoutes also has /deposits/*)
app.use('/api/deposits', depositRoutes);

// Core API
app.use('/api', transferRoutes);
app.use('/api/quote', quoteRoutes);
app.use('/api/simulate', simulateRoutes);
app.use('/api/orchestrator', orchestratorRoutes);

// AxLink Bank Network API (bearer-auth for institutional members)
app.use('/api/network', networkRoutes);

// Internal treasury ops (OPS_API_KEY — never expose to banks or users)
app.use('/api/ops', treasuryRoutes);

// Settlement harness — runs real settlements against stubbed rails.
// Mounted ONLY when explicitly enabled: it writes to the database and replaces
// the payment providers, so an environment holding customer funds must not
// expose it. Also gated by OPS_API_KEY behind this check.
if (process.env.SIMULATOR_ENABLED === 'true' && process.env.NODE_ENV !== 'production') {
  console.warn('[startup] Settlement harness ENABLED at /api/settlement/harness — payment rails are stubbable in this process');
  import('./routes/harness.routes')
    .then(m => app.use('/api/settlement/harness', m.default))
    .catch(err => console.error('[startup] Harness routes failed to mount:', err));
}

// Settlement ops: books, legs, reconciliation, provider health.
// /settlement/proof/* is intentionally public — a proof only we can read is
// not a proof. Everything else requires OPS_API_KEY.
app.use('/api/settlement', settlementRoutes);

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

  // Smart router rate protection returns 422 with clear reason
  if (err && typeof err === 'object' && (err as Record<string, unknown>).code === 'RATE_PROTECTION_TRIGGERED') {
    res.status(422).json({ error: msg, code: 'RATE_PROTECTION_TRIGGERED' });
    return;
  }

  // Bank network structured errors — use their own statusCode
  const BANK_ERR_CODES = new Set([
    'DAILY_LIMIT_EXCEEDED', 'CORRIDOR_LIMIT_EXCEEDED', 'UNKNOWN_RECEIVER_BANK',
    'RECEIVER_BANK_SUSPENDED', 'SELF_TRANSFER', 'DUPLICATE_REFERENCE',
    // Settlement engine
    'IDEMPOTENCY_CONFLICT', 'REQUEST_IN_FLIGHT', 'NO_FUNDING_ROUTE',
    'INSUFFICIENT_BALANCE', 'INVALID_AMOUNT', 'VAULT_NOT_PROVISIONED',
    'PROVIDER_CIRCUIT_OPEN', 'ALL_PROVIDERS_UNAVAILABLE',
    // An unbalanced posting is a 500, but a named one: it means a caller built
    // a posting that does not balance, and the refusal is the correct outcome.
    'UNBALANCED_POSTING', 'SETTLEMENT_PROOF_MISMATCH', 'SETTLEMENT_NOT_FINAL',
  ]);
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.code === 'string' && BANK_ERR_CODES.has(e.code)) {
      const status = typeof e.statusCode === 'number' ? e.statusCode : 422;
      res.status(status).json({ error: msg, code: e.code });
      return;
    }
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
