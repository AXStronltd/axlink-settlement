# Code structure — target layout and how this repository maps to it

Current authority: [SCOPE.md](SCOPE.md), Leg A Step 1 only. Existing fiat,
liquidity and payout paths are legacy Leg B code, preserved without expansion.
The table maps existing files; it does not authorize implementation of future modules.

The backend foundation is organized as follows:

- `src/app.ts`: HTTP application, middleware and route composition; no worker/listener startup.
- `src/index.ts`: executable entry point; starts the runtime before listening.
- `src/bootstrap/runtime.ts`: explicit provider registration and worker startup.
- `src/platform/`: validated configuration, logging, errors, health and API description.
- `src/core/institutions/`, `src/core/tenancy/`: existing institutional foundation.
- `src/providers/ports/`: future adapter contracts; not a claim of completed integration.

No broad directory move is performed while Step 1 branches remain in flight.


The brief's target is a `apps/ · packages/` monorepo. This repository already has a working
single-package backend with 174 tests and a settlement harness; moving ~90 files to new paths in
the same step as a foundation change would make the diff unreviewable (see `docs/RESTRUCTURE.md`,
written before this step, which reaches the same conclusion). Step 1 therefore **adopts the target
structure by role inside the existing tree** and adds `apps/` for the front ends. Physical moves
into `packages/` happen as a dedicated, no-behaviour-change PR once Step 1 is approved.

| Target | Today | Notes |
|---|---|---|
| `apps/web/` | `apps/web/index.html` | The AxLink front end (recovered from axlink.netlify.app), preserved |
| `apps/api/` | `src/index.ts` + `src/app.ts` + `src/routes/` | Express app; `app` exported for tests |
| `apps/workers/` | `src/core/settlement/resume.worker.ts`, `src/core/outbox.service.ts` | Run inside the API process today; split out when scaling needs it |
| `packages/core/institutions` | `src/core/institutions/` | Step 1 |
| `packages/core/auth`, `tenancy` | `src/core/tenancy/`, `src/platform/ops-auth.ts`, `src/middleware/auth.middleware.ts` (legacy bank keys) | Step 1 |
| `packages/core/ledger` | `src/core/settlement/journal.service.ts`, `accounts.ts`, `src/core/ledger.service.ts` | existing |
| `packages/core/wallets`, `assets`, `networks` | `src/core/assets/registry.ts` exists; wallet/network lifecycle is future | Registry is limited to two Solana assets |
| `packages/core/compliance` | `src/core/payment-validator.service.ts` | existing, partial |
| `packages/core/audit` | `AuditLog` model, `src/core/settlement/*` writes | existing, partial |
| `packages/core/events` | `src/core/kafka.service.ts`, `src/core/outbox.service.ts` | existing |
| `packages/settlement/transfers`, `deposits`, `payouts` | `src/core/transfer.service.ts`, `deposit.service.ts`, `orchestrator.service.ts`, `settlement/leg.service.ts` | existing |
| `packages/settlement/liquidity`, `fx` | `src/core/lp-registry.service.ts`, `fx.service.ts`, `smart-router.service.ts` | existing |
| `packages/settlement/treasury` | `src/core/treasury.service.ts` | existing |
| `packages/settlement/reconciliation` | `src/core/settlement/reconciliation.service.ts`, `proof.service.ts` | existing |
| `packages/settlement/cross-chain` | (future) | port defined in Step 1 |
| `packages/providers/ports` | `src/providers/ports/index.ts` (the five interfaces) + `src/core/ports.ts` (engine seam) | Step 1 |
| `packages/providers/custody`, `liquidity`, `blockchain`, `banking` | `src/providers/live/*` | existing adapters, grouped by file name |
| `packages/webhooks` | `src/routes/webhook.routes.ts` + provider webhook routes, `outbox.service.ts` | existing |
| `packages/shared` | `src/platform/` (config, logger, errors, health, openapi) | Step 1 |
| `packages/sdk` | (future) generate from `openapi/openapi.json` | |
| `prisma/` | `prisma/schema.prisma`, `prisma/migrations/` | existing + Step 1 migration |
| `tests/` | `src/__tests__/`, `src/simulator/` | beside the code, by choice |
| `docs/`, `infra/`, `.github/workflows/` | `docs/`, `.do/` + `Dockerfile` + `docker-compose.yml`, `.github/workflows/ci.yml` | existing |

## Dependency rule

Target rule: `src/core/**` and `src/platform/**` should not import from `src/providers/live/**`. The existing tree does not yet meet this rule. The only places
that may name a provider are `src/providers/**`, `src/bootstrap/**` (composition) and the provider
webhook routes. `src/core/ports.ts` is a legacy simulator seam; additional direct imports remain in transfer, deposit, interbank, orchestrator and reconciliation code. Mapping these services onto `src/providers/ports` requires a separately approved step.
