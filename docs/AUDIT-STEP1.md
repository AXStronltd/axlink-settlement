# AxLink — Step 1 repository audit

*2026-11-06 · repository `AXStronltd/axlink-settlement` at `f8af3c4` (main) · audited and verified by running everything, not by reading alone.*

## 1. What the repository is

A working crypto-rail settlement service, further along than its README suggests:

| Layer | Found | Verdict |
|---|---|---|
| Backend | Express 5 + TypeScript, Prisma 7 (`@prisma/adapter-pg`) on PostgreSQL. 27 source modules in `src/core`, `src/core/settlement`, `src/providers`, `src/routes`. | Solid. Typechecks clean. |
| Settlement engine | Double-entry journal balanced per currency (`journal.service.ts`), settlement legs with written plan + resume worker, on-chain proof (Solana finality, not custodian say-so), idempotency by unique constraint, provider capability model, circuit breaker + retry, reconciliation (trial balance, projection drift, custody, on-chain), outbox for member-bank webhooks. | Serious and correct in design. `docs/GAP_ANALYSIS.md` explains each piece. |
| Providers | Live adapters: Fireblocks (custody + chain execution), B2BinPay (converter), Solana RPC, Brainrock (USD payout + BaaS), Choice Bank, Daraja (M-Pesa). "Coming soon" stubs: MTN MoMo, Orange, Thunes. All stub themselves when credentials are unset (sandbox mode). | Provider-specific code is already isolated under `src/providers/`; the seam `src/core/ports.ts` lets the simulator swap converter/custody/chain. |
| Database | 690-line `schema.prisma`, 22 models. Baseline migration `00000000000000_init` exists (the README's warning that it is missing is stale). | Applied cleanly to a fresh PostgreSQL 16. |
| Auth | Member banks: Bearer key, SHA-256 hash lookup (`auth.middleware.ts`). Ops: `OPS_API_KEY` with constant-time compare on `/api/settlement/*` and `/api/ops/*`. | See security findings: most of the customer API is unauthenticated. |
| Frontend (`frontend/`) | React 19 + Vite + Tailwind internal ops dashboard: Dashboard, Users, Accounts, Transfers, Deposits, Withdrawals, Simulator, Live Demo. 14 hand-copied API types in `api.ts`. | Builds clean (282 KB JS). Not the public AxLink front end. |
| The AxLink front end | **Was not in the repository.** The live site at axlink.netlify.app (marketing, onboarding, institution portal, operator console) existed only as a deployed file. | Recovered and added as `apps/web/index.html` in this step, unchanged. |
| Tests | 11 vitest files, 174 tests (journal, legs, proof, idempotency, router, FX, capability, circuit breaker, Kafka bus, Solana). Settlement harness: 10 scenarios against stubbed rails with ledger invariants. | All green on a real database. |
| CI | GitHub Actions: Postgres service, `prisma migrate deploy`, typecheck, vitest, harness, Docker build; frontend build. | Good. Extended in this step. |
| Deployment | DigitalOcean App Platform spec (`.do/app.yaml`): pre-deploy migration job, 2 API instances, static frontend. Dockerfile multi-stage. | Sound. Not touched. |
| Docs | ARCHITECTURE, DEPLOY, GAP_ANALYSIS, INTEGRATION, LOCAL_TESTING, SIMULATOR, RESTRUCTURE, API.md (35 KB). | Thorough; a few statements stale (migrations "missing"). |
| Mock / hardcoded | Demo routes issue KYC-approved accounts (opt-in, non-prod only). Sandbox ids built with `Math.random` in provider stubs (harmless). FX fallback rates in `fx.service.ts`. | Acceptable for sandbox; flagged where it matters. |

### Verification run (this audit)

| Check | Result |
|---|---|
| `npm ci` (root, frontend) | OK |
| `npx prisma generate` · `prisma migrate deploy` on fresh PostgreSQL 16 | OK — baseline applied |
| `npx tsc --noEmit` | OK, 0 errors |
| `npx vitest run` | 174/174 passed |
| `npm run simulate` (settlement harness) | 10/10 scenarios passed |
| `cd frontend && npm run build` | OK |
| Docker image build | NOT VERIFIED (no Docker in this environment; CI does it) |
| Linting | NOT VERIFIED — no ESLint configuration exists in the repository |
| Frontend regression tests | NOT VERIFIED — none exist; `apps/web` gets a parse/route guard in this step |

## 2. What was missing (and what Step 1 added)

| Brief item | Before | After Step 1 |
|---|---|---|
| Backend bootstrap | `src/index.ts` wires everything; app not exported, so untestable over HTTP | `app` exported; listens only when run directly; HTTP tests over supertest |
| Environment validation | two required vars + placeholder warning | `src/platform/config.ts`: zod schema, every problem reported at once, production refuses simulator/demo flags and requires `OPS_API_KEY` |
| Institution and API-environment models | none (only `Bank`, a network member keyed by a single API key) | `Institution`, `ApiEnvironment` (SANDBOX / PRODUCTION, isolated), `ApiCredential` (prefix + peppered hash, scopes, expiry, revocation); `Bank.institutionId` link |
| Initial migrations | baseline present | `20261106030924_step1_institutions_and_api_environments` |
| Health and readiness | `/api/health` (liveness only, leaked callback base) | `/api/health` liveness · `/api/ready` checks database + unfinished migrations, 503 when not ready |
| Structured logging + request IDs | `console.log` (76 sites) | `src/platform/logger.ts`: JSON lines, `X-Request-Id` honoured/minted, per-request access line, credential-looking fields redacted, institution id in context. Legacy `console.*` left in place (migration is mechanical; not worth the diff in Step 1) |
| Standard error handling | ad hoc handler, bare `{error}` | `src/platform/errors.ts`: `{ error: { code, message, requestId, details } }` envelope (legacy top-level `code`/`message` kept for existing clients), zod → 400 `VALIDATION_ERROR`, malformed JSON → 400, internals never leaked in production, standard 404 |
| OpenAPI | none | `openapi/openapi.json` (3.1) served at `/api/openapi.json`, viewer at `/api/docs`; foundation endpoints documented |
| Test infrastructure | vitest + harness | + supertest HTTP tests (`platform.foundation.test.ts`, 10 tests), config/logging/key unit tests; CI runs them |
| Provider-agnostic interfaces | `core/ports.ts` seam mirroring live signatures (by design) + `lp.interface.ts`, `baas.interface.ts` | `src/providers/ports/index.ts`: `CustodyProvider`, `LiquidityProvider`, `BlockchainProvider`, `CrossChainProvider`, `FiatPayoutProvider` + role map (Fireblocks → custody + execution; B2BinPay → liquidity). Not yet wired — Step 2 maps the live adapters |
| AxLink front end | absent | `apps/web/index.html`, preserved; CI parse/route guard |

## 3. Security findings

| # | Severity | Finding | Status |
|---|---|---|---|
| S1 | **Critical** | `POST /api/network/banks/register` was unauthenticated: anyone could register a member bank and receive an API key. | **Fixed in Step 1** — now requires `OPS_API_KEY`. |
| S2 | **Critical** | The customer API (`/api/users`, `/api/transfers`, `/api/withdrawals`, `/api/deposits/*`, `/api/orchestrator/*`, `/api/quote`) has **no authentication and no tenant scoping**: any caller can read any user, move any balance. | **Fixed in the remediation branch (F4)** — `core/tenancy/customer-auth.middleware.ts`: operator key or institution credential required; institutions confined to their own customers (`User.institutionId`). Legacy rows with no institution are operator-only until backfilled. See `docs/REMEDIATION-STEP1.md`. |
| S3 | High | Member-bank API keys were generated with `Math.random` (not a CSPRNG). | **Fixed** — `crypto.randomBytes`. Existing keys should be re-issued. |
| S4 | High | `Bank.webhookSecret` stored in plaintext. | Open — Step 2 (move to hashed `ApiEnvironment.webhookSecretHash`; raw secret shown once). |
| S5 | Medium | Member-bank key hash is unpeppered SHA-256 (fine for 128-bit random keys, weak if a key is ever low-entropy). | Mitigated for new institution keys (`API_KEY_PEPPER`); legacy `Bank` keys unchanged. |
| S6 | Medium | Error handler returned raw error messages (stack-adjacent detail) on 500. | **Fixed** — generic message in production, request id for correlation. |
| S7 | Medium | `/api/health` exposed the callback base URL; `X-Powered-By` header on. | **Fixed**. |
| S8 | Low | Demo and simulator routes can be enabled by env in non-production; nothing prevented `NODE_ENV=production` with them on except a code check. | **Fixed** — config validation refuses the combination at boot. |
| S9 | Low | No rate limiting on any endpoint. | Open — Step 2 (per-credential limits on institution routes). |
| S11 | **Critical** | Fireblocks/B2BinPay/Brainrock/Choice webhooks skipped signature verification when the key was unset. | **Fixed (F2)** — fail closed (503) via `platform/webhook-policy.ts`; keys required in production. |
| S12 | **Critical** | A replayed or concurrent Fireblocks completion credited the deposit again. | **Fixed (F1)** — `ProviderEvent(provider,eventId)` unique claim in the same transaction as the posting. |
| S13 | High | USDC completions were silently dropped (USDT-only filter). | **Fixed (F3)** — asset resolved from the registry by network + contract. |
| S10 | Info | `redis` dependency unused; `kafkajs` optional. | Leave; remove `redis` in a later cleanup. |

## 4. Outstanding issues (not addressed in Step 1 by design)

- S4, S9 above (S2 fixed in remediation).
- 76 `console.*` call sites to migrate to the structured logger.
- `frontend/src/api.ts` hand-copies 14 backend types (RESTRUCTURE.md's "common/" defect) — should be generated from OpenAPI once the financial endpoints are documented.
- README/CLAUDE.md say the baseline migration is missing; it is present. Corrected in README.
- No ESLint; recommend `typescript-eslint` with the existing `tsc` strictness in Step 2.
- `apps/web` is illustrative-data only; connecting it to the API is a milestone of its own.
