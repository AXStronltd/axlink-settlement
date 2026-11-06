# AxLink scope — Leg A, Step 1 security remediation

Owner authorization: institutional digital asset custody, USDC/USDT deposits,
transfers and blockchain settlement from the sending institution to verified
receipt by the receiving institution.

AxLink does not issue, mint or redeem tokens. It accepts supported, publicly
issued stablecoins on public networks, held in regulated custody. There is no
private or permissioned settlement network. Current token definitions identify
USDC/Circle and USDT/Tether on Solana mainnet by network and mint.

The overall Leg A architecture includes institutional authentication/tenancy,
asset/network identity, wallets/addresses, immutable double-entry accounting,
provider-agnostic custody, stablecoin receipts/transfers, approved cross-chain
mechanisms, compliance/risk controls, settlement states, signed events and
reconciliation. This list is product scope, not permission to implement it all.
B2INPAY is a future optional conversion/liquidity adapter, not a dependency for
basic USDT settlement.

## Current authorized work

Step 1 final security remediation only: confirm F1–F6 against the existing
verification report and source, fix confirmed defects, demonstrate before/after
behavior, run relevant sandbox checks, obtain independent scoped Codex review
and report. Preserve both existing frontends and the current repository structure.
No new settlement features, live financial transactions or production deployment.

## Leg B — excluded

Kenyan shilling payouts, mobile money disbursements, beneficiary bank transfers,
receiving-bank fiat FX pricing, local fiat liquidity management and beneficiary
payout execution. Existing legacy code is not authorization to develop these.
Unsafe legacy customer mutations, interbank submission and fiat callbacks are
blocked by this remediation. Some privileged settlement actions, background
workers and the signed B2INPAY callback still exist; they are not production-approved.

## Stop boundary

Stop after the Step 1 remediation and independent review. Step 2, repository
restructure, provider rewiring, wallet model expansion, cross-chain implementation
and any production financial deployment require explicit owner approval.
