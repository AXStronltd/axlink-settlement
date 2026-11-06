# Institutional sandbox verification — 2026-11-07

Verified implementation commit: `c3688c6d9f11e83173088d3467c6d4453cf72d55`.
Scope: institutional crypto settlement infrastructure for future API clients. AxLink design
reference only: axlink.netlify.app. Its old token/reserve model is not the repository contract.
No token issuance, fiat payouts, bank/mobile-money development or live financial transactions.

## Result

The authenticated institution portal reads the real Express API and PostgreSQL journal. Enabled
screens are Overview, Wallet, Settlements, Counterparties, Webhooks, Transactions, Balances and
Developers. Operators have API-backed Exceptions, Approvals and Providers. Unimplemented routes
cannot reveal the historical sample dashboards. Password/SSO login and automatic KYB/funding
success have been removed from the visible onboarding path; operations must provision access.

Fixes include a null-address crash when settling to a network institution, institution identity
from the authenticated API response, removal of invented dashboard sparklines/notifications,
explicit sandbox placeholder-address warnings, same-origin credentials, surfaced refresh errors,
and shipping the full portal HTML in the API Docker image.

## Local verification

- All 14 migrations applied to a newly created local scratch PostgreSQL 16 database.
- Typecheck and backend production build passed.
- Operations React frontend production build passed.
- Web syntax, core routes and crypto-only/NDD copy guard passed.
- Vitest: **26 test files passed; 314 tests passed** (57.67 seconds). Includes five real-browser
  tests against Express + PostgreSQL and the institutional Leg A certification flow.
- Portal coverage includes API authentication, wrong-key rejection, wallet creation,
  counterparty registration, deposit-instruction persistence, rejection of overspending,
  ledger/balances/developer screens, exception acknowledgment/resolution, key clearing,
  guarded deep links and rendering a network counterparty with no external address.
- Deposit, internal/external settlement, tenant isolation, duplicate events, approvals,
  reconciliation and webhooks are covered by the existing integration/certification suites.
- External custody/chain test dependencies are stubbed. No live Fireblocks API or blockchain
  transaction was executed. These results prove local application behavior, not live settlement.

The first broad test attempt lacked a matching Chromium, and a later parallel run timed out
in browser cleanup despite passing all assertions. Final verification used installed Chrome,
explicit connection cleanup and bounded worker concurrency; all tests and suite cleanup passed.

## Separate legacy harness failure

`npm run simulate` was also run on its own freshly migrated scratch database. All ten old
bank-deposit/withdrawal scenarios failed. The first cause is that the chain fixture reports
`stub-treasury-owner` while the proof requires the specific simulated recipient. Projection
and retry-budget invariants subsequently fail. This is a pre-existing legacy harness issue;
none of this change edits that harness or the frozen fiat/FX/payout code. Do not report this
command as passing or declare the full historical CI workflow green.

## Render changes performed during this chat

- `axlink-ops` (`srv-dbn3c7jl550s73fbt3og`) temporarily published the marketing directory following
  the initial instruction, then was restored when the owner requested the complete platform.
- Current restored build: `cd apps/web/ops && npm ci && npm run build`.
- Current restored publish directory: `apps/web/ops/dist`.
- An API rewrite was added: `/api/*` → `https://axlink-settlement.onrender.com/api/*`.
- Verified through the static site's domain: `/api/health` returns HTTP 200 with sandbox true.
- API service remains on existing `main`, commit `def3e79`; `/api/ready` returns HTTP 200.
- No Render credential or environment-secret values were changed.

This branch's full portal has **not** been deployed. The proposed static configuration publishes
`apps/web`, uses `echo done`, and keeps the API rewrite. The API image update fixes `/portal`.
Review resource mapping before syncing the blueprint: duplicate ungrouped static services exist.

## Remaining release limits

- GitHub Actions jobs are blocked by the owner's GitHub billing lock; local checks are separate.
- The legacy simulator must be repaired or formally separated from the institutional CI gate.
- Docker daemon was unavailable locally, so a fresh container-image build is not verified here.
- Fireblocks credentials, signed callbacks, a dedicated RPC node and actual custody/finality
  remain unverified. Keep real-money operations disabled until the separate go-live review.
- Review and explicit authorization of the concrete sandbox deployment remain required.
