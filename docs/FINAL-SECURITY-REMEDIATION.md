# AxLink — Step 1 final security remediation

Date: 2026-11-06, Africa/Nairobi.
Branch: `codex/step1-final-security`, based on `step-1-security-remediation` at
`db745ad85ec826d6f0988897dbec00389c60e8c0`.
Implementation: **`79d4a45426fc69bdaedbb915513bb2e5ee87e1c6`**.
Red regression commit: `5dfd833`.

## 1. Summary and findings

Starting evidence was `docs/VERIFICATION-6d26e5d.md` (implementation `6d26e5d`,
verification `b673635`, historically 197 tests). The source at that implementation
confirms the six reported defects. Initial verification was not unnecessarily
repeated. The existing remediation branch already attempted F1–F6, so this work
reviewed those changes and fixed their remaining confirmed defects.

| Finding | Resolution in this change |
|---|---|
| F1: duplicate financial event credits | Retained the existing durable `(provider,eventId)` uniqueness. Only a collision while claiming that event is treated as replay; unrelated uniqueness errors propagate for retry. Pending deposit is conditionally claimed before posting. Event, balance, journal and status commit or roll back together. |
| F2: missing signature enforcement | Removed the development bypass. Capture original bytes. Verify pinned RSA-SHA512 or documented detached RS512 JWS against an operator-selected allowlisted regional JWKS endpoint. Reject missing/invalid signatures and missing key configuration. Require signed workspace identity to match `FIREBLOCKS_WORKSPACE_ID`. |
| F3: ignored USDC / unsafe deposit attribution | Both USDC and USDT accepted independently. Resolve signed provider asset ID to supported network+mint. Reject conflicting network/contract, wrong expected token, wallet, transaction binding, instruction or status. Require TRANSFER to VAULT_ACCOUNT, explicit tracking, actual net receipt, positive exact supported precision and exact expected amount. Reject internal vault movements and fiat-denominated orders. |
| F4: exposed legacy financial APIs | Unauthenticated requests fail. Institution credentials are denied all environmentless legacy customer APIs, including reads. Operators retain reads and nonproduction user provisioning; legacy customer financial mutations return 503. Legacy bank interbank submission and fiat callback routers return 503. This is safe disabling, not a completed institutional transaction API. |
| F5: float/unsafe posting arithmetic | Exact Decimal intermediates, finite/positive/range/scale validation, six-decimal token precision, conditional database debit against sufficient balance. Journal valuation no longer converts the amount to JS number; postings reject nonzero imbalance/excess scale. Custody numeric JSON net amounts preserve original decimal lexemes under Node 22+. Removed an additional Number conversion on the legacy reversal posting. |
| F6: incomplete canonical identity | Registry includes canonical ID, public network, mint, decimals and `supported`; lookup is prototype-safe and unsupported definitions do not resolve. New custody balance/journal keys use canonical `USDC_SOL` / `USDT_SOL`, keeping the two assets distinct even in one vault. |

Additional confirmed defects fixed: under/overcredit, failed-deposit resurrection,
ambiguous latest-pending attribution, cross-tenant tracking-only callbacks,
unauthenticated fiat card refund callback exposure, concurrent overdraft, swallowed
unrelated unique errors, missing double-entry custody postings, cross-workspace
signed replay, requested/net amount confusion and modern webhook envelope handling.

Actual receipt here is an authenticated custody-provider assertion tied to an
instruction, not independent RPC proof of on-chain finality. Network/mint identity
is resolved from the signed provider asset ID; conflicting supplied metadata is
rejected. No live transaction or RPC finality certification was performed.

## 2. Files changed

Application/security code:
- `.env.example`
- `src/core/assets/registry.ts`
- `src/core/fx.service.ts`
- `src/core/ledger.service.ts`
- `src/core/provider-events/custody-deposit.ts`
- `src/core/provider-events/provider-event.service.ts`
- `src/core/settlement/journal.service.ts`
- `src/core/settlement/payout-confirmation.service.ts`
- `src/core/tenancy/customer-auth.middleware.ts`
- `src/index.ts`
- `src/platform/config.ts`, `errors.ts`, `webhook-policy.ts`
- `src/providers/live/fireblocks-webhook.ts` (new verification helper)
- `src/routes/network.routes.ts`, `webhook.routes.ts`

Tests:
- `src/__tests__/final-security.test.ts` (new, 35 tests)
- `src/__tests__/fireblocks-signatures.test.ts` (new, 4 tests)
- `src/__tests__/journal.test.ts`
- `src/__tests__/remediation.step1.test.ts`

Reports/scope: this file, `docs/INDEPENDENT-REVIEW-STEP1-FINAL.md`, `docs/SCOPE.md`.
Existing fixture payloads now use documented net-receipt fields and asset-denominated
instructions. Institutional legacy tests expect denial, rather than retaining unsafe
access. Operator fixtures create synthetic rows directly; no new financial API added.

No files moved, no repository restructure, no frontend source/lockfile/image change,
no new wallet/transfer/cross-chain feature. The prior foundation PR's application
split is not part of this branch.

## 3. Database migrations

**No new migration.** This change reuses the remediation schema and existing tables:
`ProviderEvent`, canonical-asset-keyed `Account`, `JournalEntry`, `JournalLine`,
`BankDeposit.settlementAssetId`, and `User.institutionId`.

Existing migrations applied successfully to new isolated PostgreSQL 16 databases:
- `00000000000000_init`
- `20261106030924_step1_institutions_and_api_environments`
- `20261106040249_step1_security_remediation`

No historical balances were converted, backfilled or relabelled. Preexisting
symbol/fiat balances remain legacy records and require reconciliation before any
future migration. New custody postings use canonical asset IDs.

## 4. Before/after evidence

The original six defects were already documented in the supplied verification
report, including duplicate balance 100 → 200 and unauthenticated financial access.
Their historical 197-test run is supplied evidence, not a newly executed run here.

New remaining-defect regressions were executed against unchanged `db745ad` source
in a detached local checkout, then against the remediation:

| Evidence | Before | After |
|---|---|---|
| Red commit `5dfd833`, initial 25-case regression file | **24 failed / 1 passed** | All corresponding cases pass |
| Final 35-case regression file against original `db745ad` source | **32 failed / 3 passed** | **35 passed** |
| Four new signature/JWKS tests | Not present before; new documented-method coverage | **4 passed** |
| Complete suite | Existing branch's reported baseline: 216 | **255 passed / 16 files**, no failures/skips |
| CI-runtime subset | — | **39 passed on Node 22** |

Before/after cases include replay and ten-way concurrency, distinct events targeting
the same deposit, unrelated unique violation propagation, both assets on one wallet,
wrong token/network/mint, wrong status and missing tracking, negative/nonfinite/
overprecision amounts, underpayment/overpayment, exact large JSON net amounts,
concurrent debits, full transaction rollback, unauthorized and cross-institution
access denial, workspace mismatch/missing configuration, V2 completion, requested
versus net amount, and invalid operation/destination/internal source.

## 5. Builds and regression checks

Environment: isolated local PostgreSQL 16.15; primary run Node 26.7.0/npm 11.19.0;
new security subset also executed using Node 22. No production credentials or data.

| Check | Result |
|---|---|
| `npm run verify` | Passed: typecheck, site route/parse guard, 255 tests |
| `npm run build` | Passed |
| `frontend/npm run build` | Passed |
| Existing settlement harness, separate freshly migrated scratch DB | **10/10 passed**, custody/converter/RPC mocked |
| Browser site regression | **60 routes, no bad renders or console/page errors**, checked as client/operator |
| Both frontend directories against `db745ad` | Byte-for-byte unchanged |
| Diff whitespace check | Passed |

The existing browser render check was run with the locally installed Chrome
executable in place of its environment-specific path. Screenshot-writing calls
were omitted in memory so regenerated PNG noise never touched tracked files.
This is a functional render check, not a pixel-perfect visual comparison. No
existing dashboard browser-test suite was found; its production build is verified.
Docker image validation was not repeated: no image files changed in this branch
and the local daemon remains unavailable. No production deployment performed.

## 6. Remaining risks and deployment blockers

These changes do not make the repository production-ready:

- Legacy institutional financial APIs are deliberately unavailable, not replaced.
  Proper wallet/environment-scoped APIs need a separately authorized milestone.
- Privileged settlement operations (advance/tick/confirm), the signed B2INPAY
  callback and legacy workers still exist; workers default enabled in existing
  configuration. They were disabled for HTTP tests. This report does not claim
  every legacy execution surface was removed. Do not run them against live funds
  without a separate complete review and explicit production approval.
- Dormant legacy interbank/proof/fiat internals retain old assumptions. In
  particular the old interbank service reports custody acceptance as completion;
  HTTP submission is now blocked. These paths are explicit deployment blockers,
  not approved live settlement mechanisms.
- Live provider authenticity, custody response mapping, dedicated Solana RPC
  verification, institutional receiving-wallet finality and actual JWKS key
  rotation were not certified by sandbox tests. JWKS tests use generated keys
  and mocked public-key responses.
- Exact-match receipt policy rejects fee-short/overpaid receipts for operator
  reconciliation. Missing tracking, missing net receipt or unsupported source/
  destination is not guessed. Recorded rejected events are acknowledged but
  never credited; correction requires controlled reconciliation.
- New receipt accounting uses canonical token accounts. No backfill of legacy
  balances/journals is performed; total historical books may still have drift.
- Optional conversion remains legacy code, not required by the new custody
  receipt path. Fiat FX, payouts and liquidity remain excluded Leg B work.
- Existing dependency advisories (previous audit: backend 25, frontend 7), outbound
  signing secret storage, rate limiting, environment/schema readiness limitations
  and DB-role-level journal immutability need separate release review. No automatic
  dependency update or unrelated module implementation is included.

## 7. Independent Codex review

A separate Codex review agent reviewed actual code and identified additional high
findings, which were fixed before re-review. Final result for implementation
`79d4a45`: **no remaining critical/high finding identified within the reviewed
F1–F6 remediation diff**. Independently executed checks: TypeScript and four
signature tests passed. Broader checks above were executed by the implementation
agent; the reviewer inspected their evidence without repeating the whole suite.

See `INDEPENDENT-REVIEW-STEP1-FINAL.md`. This is a scoped independent review pass,
not GitHub bot approval, blanket repository approval or production authorization.

## 8. Stop status

Step 1 security remediation and scoped independent review complete. No merge,
production transaction or deployment. **Step 2 remains unapproved and stopped.**
