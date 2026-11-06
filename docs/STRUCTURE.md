# Repository structure

*Applied on `main` on 2026-11-06. One front end, one back end, one `npm install`, one test command. No workspaces, no path aliases: imports are plain relative paths, so `tsc`, `ts-node`, vitest and the Docker build all resolve them the same way.*

```
axlink-settlement/
├── apps/
│   ├── web/                    # AxLink front end (index.html, 60 routes) — the institution portal and operator console
│   │   ├── ops/                #   internal ops dashboard (React/Vite) — builds and deploys on its own
│   │   └── tools/              #   alignment script and route render check
│   ├── api/                    # Express API: boot, routes, HTTP concerns
│   │   ├── src/index.ts        #   app wiring (exports `app`; listens when run directly)
│   │   ├── src/routes/         #   HTTP routes incl. webhooks, institutions, settlement ops
│   │   ├── src/platform/       #   health/readiness, OpenAPI viewer, operator auth
│   │   ├── src/bootstrap/      #   provider registration at boot
│   │   ├── src/simulator/      #   settlement harness (certification) and its routes' engine
│   │   └── public/console.html #   local operator console (never shipped in the image)
│   └── workers/                # reserved — resume worker still runs inside the API process
├── packages/
│   ├── shared/                 # config (zod), structured logger, error envelope
│   ├── core/
│   │   ├── institutions/       # Institution, API environments, credentials
│   │   ├── auth/               # member-bank API-key middleware
│   │   ├── tenancy/            # requireInstitution / requireScope; customer-API actor + tenant guard (F4)
│   │   ├── ledger/             # double-entry journal, account codes, legacy ledger service
│   │   ├── assets/             # asset registry: network + contract + decimals (F6)
│   │   ├── idempotency/        # unique-constraint idempotency
│   │   ├── events/             # event bus (Kafka or in-process), outbox, bank webhooks
│   │   └── wallets/ networks/ compliance/ audit/   # reserved
│   ├── settlement/
│   │   ├── orchestration/      # settlement legs, resume worker, USD corridor
│   │   ├── proof/              # on-chain proof (Solana finality + mint/amount check)
│   │   ├── reconciliation/     # trial balance, projection drift, custody and on-chain checks
│   │   ├── transfers/          # customer transfers, interbank, smart router, validator, legacy orchestrator
│   │   ├── deposits/           # fiat on-ramp deposits
│   │   ├── treasury/           # treasury operations
│   │   ├── fx-quotes/          # FX rates and quotes
│   │   ├── bank-payouts/       # payout confirmation (Leg C surface, unchanged)
│   │   └── liquidity/ cross-chain/   # reserved
│   ├── providers/
│   │   ├── ports/              # the five provider interfaces, one file each + runtime seam
│   │   ├── custody/fireblocks/ # custody + chain execution
│   │   ├── liquidity/b2binpay/ # liquidity provider (fiat ↔ USDC/USDT)
│   │   ├── blockchain/solana/  # RPC: finality and token transfers
│   │   ├── blockchain/ethereum/ polygon/   # reserved
│   │   ├── banking/            # Brainrock, Choice Bank, Daraja, coming-soon stubs (fiat rails)
│   │   ├── registry/           # LP and BaaS registries
│   │   └── runtime/            # capability model, circuit breaker, retry, attempt log
│   ├── webhooks/               # admission policy (F2), exactly-once provider events (F1), custody deposit (F3)
│   └── sdk/                    # reserved — generated from OpenAPI later
├── prisma/                     # schema + migrations
├── openapi/                    # openapi.json served at /api/openapi.json
├── tests/
│   ├── unit/                   # no database
│   ├── integration/            # real PostgreSQL (foundation, verification, remediation)
│   ├── certification/          # the settlement harness (npm run simulate)
│   └── contracts/ e2e/         # reserved
├── docs/
├── infra/                      # Dockerfile (build from repo root: docker build -f infra/Dockerfile .), docker-compose
├── .do/app.yaml                # DigitalOcean App Platform spec
└── .github/workflows/ci.yml
```

Commands (unchanged): `npm run dev` · `npm run build` · `npm start` · `npx vitest run` · `npm run simulate` · `npm run check:web` · `cd apps/web/ops && npm run build`.

Reserved folders hold a one-line README and no code; they exist so the layout is settled before the code arrives, and are filled only after Codex review and approval.
