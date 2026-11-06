# AxLink development scope — Leg A, Step 1

Owner instruction, 2026-11-06. This scope supersedes conflicting roadmap statements,
including earlier references to fiat payout coordination or alternative meanings of Leg B.

## Product boundary

Leg A is institutional digital asset settlement infrastructure, from the sending
institution to verified receipt by the receiving institution. It covers:

1. Institutional authentication and multi-tenancy.
2. Asset and blockchain network registry.
3. Institutional wallets and receiving addresses.
4. Immutable double-entry ledger.
5. Fireblocks custody adapter.
6. Stablecoin deposits and transfers (USDT and USDC).
7. Cross-chain routing and settlement through verified, approved mechanisms.
8. Compliance, transaction monitoring and risk controls.
9. Settlement state machine and transaction status.
10. Signed webhooks and reconciliation.

Keep core services provider-agnostic. B2INPAY (named `b2binpay` in existing code)
is a future optional liquidity adapter for digital asset conversion; it is not
required for basic USDT settlement. Neither an interface nor a passing stub test
means a live provider or cross-chain mechanism has been verified or approved.

## Leg B — excluded from current development

- Kenyan shilling payouts and mobile money disbursements.
- Local bank transfers to beneficiaries.
- Receiving bank fiat FX pricing.
- Local fiat liquidity management.
- Beneficiary payout execution.

Existing fiat modules remain legacy code for compatibility and regression checks.
Their presence, routes and tests do not place them in the active development scope.
Do not extend them or describe them as a Leg A dependency.

## Current authorization: Step 1 only

Audit and organize the existing repository, establish the backend foundation, run
relevant checks and report results. Preserve both existing frontends. Do not
implement the full Leg A module list or unrelated modules. Do not start Step 2
without explicit owner approval. No production deployment is authorized here.

Current work includes a documented repository map, testable HTTP application,
explicit process startup, environment validation, existing institutional foundation,
provider boundaries and verification evidence. Physical monorepo migration,
shared frontend type rewiring, wallet models, live custody integration and
cross-chain execution await a separately approved step.
