# AxLink institution portal

`index.html` preserves the AxLink visual design and public website. The application is crypto
settlement infrastructure for institutional API clients: USDC/USDT on Solana, custody vaults,
deposit instructions, network and external counterparties, outbound settlement, double-entry
ledger statements, balances and signed webhook deliveries. AxLink issues no token.

## Run and connect

Serve the page from the API at `/portal`, or a static site that rewrites `/api/*` to the API.
Both institution and operator requests use the same origin. API keys remain in sessionStorage
for the current tab; keys are authenticated before a connected session is shown.

- Institution credentials open Overview, Wallets, Settlements, Counterparties, Webhooks,
  Transactions, Balances and Developers. Every screen reads `/api/v1` and every enabled
  mutation calls that API.
- Operator credentials open Exceptions, Approvals and Providers, backed by `/api/settlement`.
- Unknown or unfinished application routes cannot open the old illustrative dashboards,
  including manually entered deep links. Password, SSO and automatic KYB sign-up are not
  implemented and are not presented as working authentication.
- Operations provisions institutions after onboarding. `npm run seed:sandbox` creates the
  reference sandbox institution and wallet against a local scratch database; it can issue
  a sandbox credential, so never run it against a customer database as a demo shortcut.

## Sandbox truthfulness

Sandbox vaults and addresses may be provider stubs. The portal labels sandbox activity and
warns not to send funds to a placeholder address. A recorded instruction is not a completed
blockchain deposit. A connected API is not evidence that Fireblocks is configured. The
Providers screen reports adapter configuration and health. External custody, signatures and
on-chain finality still need separate provider verification before live usage.

## Deployment

The API image includes the portal at `dist/apps/web/index.html`. `render.yaml` describes a
sandbox API and a full static portal with an API rewrite. Apply the intended configuration
through review; do not sync a blueprint over existing services without checking its resource
mapping. The current historical `axlink-ops` name is retained for compatibility.

## Verification

`npm run check:web` checks syntax, core routes and the crypto-only copy guard.
`tests/integration/portal.step2.test.ts` exercises the real Express API and a migrated local
Postgres in Chromium. It verifies authentication, wallet creation, counterparty registration,
deposit instructions, insufficient-balance rejection, ledger screens, operator exception
resolution, safe deep links, network counterparties and sign-out. Stubbed provider tests
verify software behavior; they do not verify live settlement.
