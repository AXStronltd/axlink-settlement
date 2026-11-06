// MUST be the first import. ES module imports are hoisted and evaluated in
// order, so every module below initialises before any statement in this file
// runs. Modules that read process.env at module scope — orchestrator.service
// (TREASURY_VAULT), transfer.service (CALLBACK_URL), treasury.service — were
// therefore capturing undefined while a later dotenv.config() made the values
// appear present to everything that checked afterwards. The side-effect import
// loads .env during module resolution, before those constants are evaluated.
import 'dotenv/config';

import express, { Request } from 'express';
import path from 'path';
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
import institutionRoutes from './routes/institution.routes';
import walletRoutes      from './routes/wallet.routes';
import depositInstructionRoutes from './routes/deposit-instruction.routes';
import settlementStatusRoutes   from './routes/settlement-status.routes';
import webhookEndpointRoutes    from './routes/webhook-endpoint.routes';
import v1Routes                 from './routes/v1.routes';
import { loadConfig } from '../../../packages/shared/config';
import { log, requestContext } from '../../../packages/shared/logger';
import { errorHandler, notFoundHandler } from '../../../packages/shared/errors';
import { healthRouter } from './platform/health';
import { openapiRouter } from './platform/openapi';


// Validate configuration before anything else; every problem is reported at once.
export let cfgReport: ReturnType<typeof loadConfig>;
try { cfgReport = loadConfig(); }
catch (e) { console.error(`[startup] ${(e as Error).message}`); process.exit(1); }
if (cfgReport.sandboxProviders.length) log.warn('startup.sandbox_mode', { unsetCredentials: cfgReport.sandboxProviders });

export const app = express();
const PORT = cfgReport.config.PORT;

app.disable('x-powered-by');
app.use(requestContext);

app.use(express.json({
  verify: (req: Request & { rawBody?: string; rawBodyBuffer?: Buffer }, _res, buf) => {
    req.rawBodyBuffer = Buffer.from(buf);
    req.rawBody = buf.toString();
  },
} as Parameters<typeof express.json>[0]));

// Health (liveness), readiness (DB + migrations), OpenAPI
app.use(healthRouter());
app.use(openapiRouter());

// Institutions (tenants) and API environments — operator-administered in Step 1
app.use('/api/institutions', institutionRoutes);
app.use('/api/wallets', walletRoutes);
// Step 2 institution API. `/api/v1` is the canonical contract (blueprint names); the routes below
// are aliases of the same services, kept for anything already integrated. Mounted before the legacy
// /api/deposits and provider /api/webhooks routers.
app.use('/api/v1', v1Routes);
app.use('/api/deposits/instructions', depositInstructionRoutes);
app.use('/api/settlements', settlementStatusRoutes);
app.use('/api/webhooks/endpoints', webhookEndpointRoutes);

app.get(['/', '/api'], (_req, res) => {
  const base = process.env.API_BASE_URL ?? `http://localhost:${PORT}/api`;
  res.json({
    service: 'AxLink Settlement API',
    version: '2.0.0',
    settlement: 'Leg A — institutional digital asset settlement to verified receiving-institution receipt',
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

  // The operator console. Static HTML — it authenticates by passing
  // ?key=<OPS_API_KEY> through to the harness API, so the page itself carries
  // no secret and serving it reveals nothing.
  app.get('/console', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'console.html'));
  });
}

// Demo endpoints for the Live Demo UI. Hands out KYC-approved accounts, so it
// is mounted only on an explicit opt-in and never in production.
if (process.env.DEMO_ENABLED === 'true' && process.env.NODE_ENV !== 'production') {
  console.warn('[startup] Demo API ENABLED at /api/demo — issues KYC-approved accounts');
  import('./routes/demo.routes')
    .then(m => app.use('/api/demo', m.default))
    .catch(err => console.error('[startup] Demo routes failed to mount:', err));
}

// Settlement ops: books, legs, reconciliation, provider health.
// /settlement/proof/* is intentionally public — a proof only we can read is
// not a proof. Everything else requires OPS_API_KEY.
app.use('/api/settlement', settlementRoutes);

// Webhooks — inbound callbacks from rails and custody
// Frozen Leg B callback handlers include unauthenticated refund paths. Do not
// expose them while developing Leg A; a future approved Leg B step must secure them.
app.use(['/api/webhooks/brainrock', '/api/webhooks/daraja', '/api/webhooks/choicebank'], (_req, res) => {
  res.status(503).json({ error: 'Legacy fiat callbacks are disabled in Leg A', code: 'LEG_B_DISABLED' });
});

app.use('/api/webhooks', webhookRoutes);
app.use('/api/webhooks', brainrockRoutes);
app.use('/api/webhooks', darajaRoutes);
app.use('/api/webhooks', choicebankRoutes);

// 404 for unknown routes, then the standard error envelope
app.use(notFoundHandler);
app.use(errorHandler);

