# AxLink Leg A — go-live checklist

Production is a decision, not a deploy. Every line below is ticked by a named person before
`OUTBOUND_SETTLEMENT_ENABLED=true` is set and before any institution's PRODUCTION environment is
enabled. The owner signs the whole list.

## 1. Custody (Fireblocks, production workspace)
- [ ] Production workspace with its own API user; the key file lives only on the API host (`FIREBLOCKS_SECRET_KEY_B64`), never in git or chat
- [ ] Transaction Authorization Policy: outbound from AxLink vaults only to whitelisted addresses; internal vault-to-vault allowed; a human co-signer above the agreed amount
- [ ] Webhook public key (and/or JWKS URL) configured; `ALLOW_UNVERIFIED_WEBHOOKS` unset
- [ ] `FIREBLOCKS_SANDBOX` unset; `GET /api/settlement/providers` shows custody `configured: true`, health ok

## 2. Chain
- [ ] `SOLANA_RPC_URL` is a dedicated node (Helius / Triton / QuickNode / own validator); boot refuses the public endpoint
- [ ] `GET /api/settlement/infra` reports the node reachable and current
- [ ] `RECON_ONCHAIN_ADDRESSES` lists every production vault address so reconciliation checks on-chain positions

## 3. Screening and policy
- [ ] A screening provider adapter is registered (Chainalysis / Elliptic / TRM) and `SCREENING_OPTIONAL` is unset — or the decision to run without one is written down and signed by compliance
- [ ] Deployment limits reviewed: `TRANSFER_MAX_AMOUNT`, `TRANSFER_DAILY_LIMIT`, `TRANSFER_MAX_PER_HOUR`; per-institution overrides set where agreed
- [ ] Operator approval roster: who may approve transfers and counterparties, and who reviews UNDER_REVIEW transfers with evidence

## 4. Secrets and keys
- [ ] `OPS_API_KEY` rotated for production and held by named operators only
- [ ] `WEBHOOK_ENCRYPTION_KEY` generated for production (64 hex) and backed up in the secret store
- [ ] `DATABASE_URL` to the managed Postgres with daily backups and point-in-time recovery verified by a restore test
- [ ] `.env`, `fireblocks_secret.key`, `fireblocks.csr` confirmed gitignored; no secret in any committed file (`git log -p | grep` spot check)

## 5. Verification on the production deployment (before any institution is enabled)
- [ ] `npm run certify` passes against the production database with sandbox-mode institutions removed
- [ ] `GET /api/settlement/books/trial-balance` balanced; `/stuck` empty; `/exceptions` no CRITICAL
- [ ] A full reconciliation run (`POST /api/settlement/reconcile` FULL) is CLEAN
- [ ] Portal served at `/portal` with the security headers; operator console signs in with the production ops key

## 6. First institution
- [ ] Institution created by operations, onboarding completed by compliance, status set ACTIVE
- [ ] PRODUCTION environment enabled for that institution only; a key issued and handed over out of band
- [ ] Their webhook endpoint registered and a test event delivered (`GET /v1/webhook-endpoints/{id}/deliveries`)
- [ ] First inbound deposit observed end to end: PROCESSING → COMPLETED on finality, visible in their ledger
- [ ] First outbound settlement: operator-approved, SETTLED with `ON_CHAIN_FINALIZED`, counterparty verified on an explorer

## 7. Switch
- [ ] `OUTBOUND_SETTLEMENT_ENABLED=true` set by the owner, with the date, in the change log
- [ ] Daily routine in [DEPLOY.md](DEPLOY.md) assigned to a named operator

Signed: ____________________ (owner)   Date: __________
