# AxLink web — the AxLink front end

`index.html` is the AxLink front end: marketing site, institution onboarding, institution portal and
operator console in one self-contained file (no external scripts), with an in-page router (60 routes).

## History

- Recovered 2026-11-06 from the live deployment at axlink.netlify.app, unchanged (commit `7a02d2a`).
- Aligned 2026-11-06 to the crypto-settlement backend (`tools/align_crypto.py`, re-runnable against
  the recovered original; every replacement is explicit and the script fails if an anchor is missing):
  - Positioning: public stablecoin (USDC on Solana) in regulated custody; nothing minted, nothing lent;
    finality proven on-chain. Zero NDD references remain (`scripts/check-web.js` enforces this).
  - Institution portal: **Wallet** (custody vault, deposit address, deposits/withdrawals), **Settlements**,
    **Counterparties** (whitelisted wallets), **Webhooks** (signed deliveries), **Developers** (the real
    API: `axlk_test_`/`axlk_live_` keys, `/api/institutions/me` live, planned endpoints marked
    `planned`, signature header, error envelope). Sandbox/production environment switch in the sidebar.
  - Operator console: **Treasury** (reserve vault, institution floats, rebalances with two approvers),
    **Approvals**, **Providers** (adapters behind ports with health).
  - Demo tenant is Galaxy Bank (`galaxy-bank-so`), the first reference client.

## What is live vs illustrative

Everything on the page is illustrative sample data and says so in the banner. The Developers page
documents two live endpoints (`/institutions/me`, `/health` + `/ready`) and the planned ones; the
portal is not yet connected to the API. Connecting it (institutions, wallet, settlements, webhooks)
is a milestone of its own after the backend modules exist.

## Checks

- `node scripts/check-web.js` — inline JS parses, title and core routes intact, no NDD references.
- `node apps/web/tools/render_check.js` — renders every route as client and operator in headless
  Chromium and fails on any render error (requires `playwright`, already a dev dependency).
