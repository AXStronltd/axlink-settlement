# Leg A Step 1 — repository and foundation review

Date: 2026-11-06 (Africa/Nairobi).
Repository: AXStronltd/axlink-settlement.
Base: `step-1-security-remediation`, `db745ad85ec826d6f0988897dbec00389c60e8c0`.
Review branch: `codex/leg-a-step-1-audit`.

## Scope and branch selection

The owner authorized Leg A Step 1 only: audit, repository organization and backend
foundation. No Step 2, production deployment, frontend changes or new financial
modules are included. Leg A ends at verified digital asset receipt by the receiving
institution. Local fiat delivery, receiving-bank FX and fiat liquidity belong to
Leg B. `docs/SCOPE.md` is the authoritative boundary.

`main` (`f8af3c4`) does not include the existing Step 1 work. The repository also
has `step-1-foundation` and a descendant `step-1-security-remediation`. This review
builds on the latter, rather than rebuilding those changes or overwriting Claude's
branches. No upstream branch was merged or rewritten.

## Repository audit

| Area | Existing implementation | Assessment |
|---|---|---|
| Backend | Express 5, strict TypeScript, Prisma/PostgreSQL | Foundation present; application and process startup needed separation |
| Institutional foundation | Institution, API environment, hashed credentials, issuance/revocation, tenant middleware | Tested foundation; full authorization and data environment separation remain incomplete |
| Database | Baseline plus institution and security-remediation migrations | All three apply to an empty isolated PostgreSQL 16 database |
| Ledger/recovery | Decimal posting, journal, persisted settlement legs, resume worker, proof and reconciliation services | Existing engine preserved; passing stub tests do not prove every API uses it |
| Provider boundaries | Future role interfaces plus existing engine seam | Partial: direct live-provider imports still exist outside the engine; no provider rewiring performed |
| Assets | USDT and USDC Solana registry, exact minor-unit conversion | Limited registry; not a completed asset/network approval lifecycle |
| Webhooks | Signature admission, provider-event deduplication and transactional postings | Database-backed tests cover replay, concurrent delivery and rollback; not live provider certification |
| Frontends | `frontend/` dashboard and `apps/web/` site | Both directories byte-for-byte unchanged from the selected base |
| Legacy fiat | Daraja, Choice Bank, Brainrock, FX, converter, payout and treasury paths | Frozen compatibility code; excluded from new Leg A development |
| Cross-chain | Contract/interface only | No approved live mechanism implemented or verified |
| CI/deployment | Backend checks, Postgres, harness, image build, frontend build | Existing workflow retained; runtime image was missing its served OpenAPI file |

## Changes in this review

1. Added `AGENTS.md`; replaced conflicting scope language in `docs/SCOPE.md` and
   added scope pointers in README/CLAUDE working notes. Updated the repository map
   to distinguish current structure from proposed future paths.
2. Extracted HTTP composition into `src/app.ts`, left `src/index.ts` as the entry
   point, and added `src/bootstrap/runtime.ts`. Importing the app no longer starts
   workers, registers providers or opens a listener. The executable awaits provider
   registration and validator initialization before listening; initialization failure
   exits instead of serving with a failed validator.
3. Removed the unconditional production requirement for a B2INPAY callback secret.
   If either B2INPAY client credential is configured, its callback secret remains
   required. Custody verification and fail-closed webhook admission are unchanged.
   This is a configuration fix, not implementation of a new stablecoin transfer flow.
4. Included `openapi/` in the Docker build and runtime stages so `/api/openapi.json`
   has its checked-in file in the image.
5. Added four runtime-startup tests and one optional-adapter configuration test;
   updated the existing production-key test to cover configured B2INPAY.

No schema migration, new wallet, new cross-chain execution, financial posting
rewrite or frontend change is introduced. Broad physical directory moves are
unnecessary while existing Step 1 branches remain in flight; the actual boundary
between app composition and process startup is now explicit.

## Verification run

Environment: macOS arm64, Node 26.7.0, npm 11.19.0, PostgreSQL 16.15. CI targets
Node 22; that runtime was not separately exercised locally. All data below is
synthetic in two new scratch databases on a dedicated local Postgres instance.
No production database or real provider credentials were used.

| Check | Result |
|---|---|
| Root and frontend `npm ci` | Passed; lockfiles unchanged |
| Prisma client generation and schema validation | Passed |
| All three migrations on a fresh DB | Passed; migration status up to date |
| `npm run verify` | Passed: strict typecheck, site parse/route guard, **221 tests / 15 files**, no failures or skips |
| `npm run build` | Passed |
| Existing settlement harness | **10/10 passed**, converter/custody/RPC stubbed; separate fresh database |
| Compiled server startup | Passed without B2INPAY or other provider credentials; legacy sandbox behavior only |
| Compiled HTTP smoke | Health 200, readiness 200, OpenAPI 200 (3.1.0) |
| Frontend production build | Passed (38 modules) |
| Site parse/route guard | Passed: 289 KB, 61 routes |
| Frontend preservation | No diff in `frontend/` or `apps/web/` |
| Whitespace/diff check | Passed |
| Docker build | Attempted, blocked: local Docker daemon unavailable; image changes unverified in a running container |
| Browser visual regression | Not run; neither frontend was changed; parse guard and dashboard build are not visual tests |
| ESLint | Not run; no repository ESLint configuration |

The first harness attempt correctly refused the database populated by HTTP tests.
It was rerun on its own freshly migrated empty database; the populated-database
safety check was not bypassed.

## Open findings — not a production approval

- **Verified receipt is not enforced on the legacy interbank path.**
  `src/core/interbank.service.ts` marks a transfer COMPLETED after custody submission
  and emits `solanaTxHash: null`. It must not be presented as proof of receiving-
  institution receipt. Wiring it to the engine is financial behavior work requiring
  a separately approved step.
- **Provider-agnostic migration is incomplete.** Existing core services import
  Fireblocks/B2INPAY directly. The legacy converter port and LP registration remain;
  basic asset settlement must eventually bypass optional conversion explicitly.
  This review removes only the unconditional boot credential dependency.
- **Tenant environment and scope enforcement are incomplete on legacy APIs.**
  Credentials carry environment/scopes, but legacy customer ownership is keyed by
  institution only. A sandbox key is not a separate data plane. Full wallet and
  transaction ownership/environment constraints need a later approved design.
- **Readiness has limited migration coverage.** It checks the DB migration table for
  unfinished rows, not whether newly checked-in migrations are absent from that
  table. It also does not prove live custody/provider readiness.
- **Async demo/harness route mounting remains legacy behavior.** Their dynamic
  mounting occurs after the standard terminal handlers are registered; their HTTP
  reachability is not established by the CLI harness. No new demo functionality
  was added in this scope.
- **Compliance, institution wallet lifecycle, cross-chain approval and verified
  receiving-institution attribution are not completed by these foundation tests.**
- **Webhook signing secret storage and rate limits remain open.** Outbound HMAC
  signing needs a recoverable secret (e.g. encrypted storage/secret manager); simply
  hashing it would not allow signatures to be generated.
- **Dependency audit remains open.** Root dependency graph reports 25 advisories
  (9 moderate, 15 high, 1 critical); frontend graph reports 7 (2 moderate, 5 high).
  The critical backend advisory is in transitive `proxy-addr`. These are package
  audit findings, not a demonstrated exploit assessment. No automatic dependency
  upgrade or frontend lockfile modification was performed in this review.

Step 1 review work is finished with the limitations above. Step 2 remains blocked
by the owner's explicit approval boundary. No deployment or merge is performed.
