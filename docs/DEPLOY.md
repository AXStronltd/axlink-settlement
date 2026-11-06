# Deploying AxLink (Leg A)

> **Authorisation.** Nothing in this repository deploys to production on its own. A production deploy
> happens only when the owner has signed off the go-live checklist in [GO-LIVE.md](GO-LIVE.md). The
> sandbox deployment described here is the one engineers and integrators use.

## Migrations

`prisma/migrations/` is the schema history (baseline, Step 1, every Step 2 slice). Apply it with
`npx prisma migrate deploy` on an isolated database; new changes go through
`npx prisma migrate dev --name <change>` (or `migrate diff` + a hand-named folder when the dev
command cannot run non-interactively). One index is a Postgres partial unique index that Prisma
cannot express (`OperationalException_open_one_per_subject`); `prisma migrate diff` reports no
drift for it — if a future tool proposes dropping it, keep it.

## Deploy

```bash
doctl apps create --spec .do/app.yaml            # first time
doctl apps update <APP_ID> --spec .do/app.yaml   # afterwards
```

The spec provisions managed Postgres 16, runs `prisma migrate deploy` as a
`PRE_DEPLOY` job, then rolls out the API, which also serves the institution portal at `/portal`.

Migrations run as a pre-deploy job rather than from the start command on
purpose: from the start command, the first request can arrive before the
migration finishes, and every instance races the same migration. A pre-deploy
job runs once and blocks the rollout if it fails.

## Secrets

Everything marked `type: SECRET` in the spec must be set before the first
deploy, in the DO control panel under **Settings → App-Level Environment
Variables**, or with `doctl`. Nothing sensitive is committed.

| Variable | Notes |
|---|---|
| `SOLANA_RPC_URL` | **Use a dedicated endpoint.** See below. |
| `FIREBLOCKS_API_KEY` | |
| `FIREBLOCKS_SECRET_KEY_B64` | `base64 -i fireblocks_secret.key \| pbcopy` |
| `FIREBLOCKS_TREASURY_VAULT` | |
| `FIREBLOCKS_WEBHOOK_PUBLIC_KEY` | Full PEM |
| `B2BINPAY_CLIENT_ID` / `_SECRET` / `_CALLBACK_SECRET` / `_WALLET_ID` | |
| `BRAINROCK_API_KEY` / `_WEBHOOK_SECRET` / `_TREASURY_ACCOUNT_ID` | |
| `OPS_API_KEY` | Gates every `/api/settlement/*` route except the public proof endpoint; also the operator console sign-in |
| `WEBHOOK_ENCRYPTION_KEY` | 64 hex chars; encrypts institution webhook secrets at rest. Required in production |
| `RECON_ONCHAIN_ADDRESSES` | `label=address,label=address` |
| `OUTBOUND_SETTLEMENT_ENABLED` | `false` until go-live is signed off. With it unset, PRODUCTION transfers are refused at create, approve and submit |
| `SCREENING_OPTIONAL` | Leave unset. `true` lets PRODUCTION register external counterparties without a screening provider — a documented decision only |
| `TRANSFER_MAX_AMOUNT` / `TRANSFER_DAILY_LIMIT` / `TRANSFER_MAX_PER_HOUR` | Deployment defaults (1,000,000 / 5,000,000 / 200); operations override per institution environment with `PATCH /api/institutions/{id}/environments/{kind}/policy` |
| `TRANSFER_AUTO_APPROVE_LIMIT_SANDBOX` | Sandbox-only auto-approval threshold (100,000). PRODUCTION always needs an operator |
| `MAX_WALLETS_PER_ENVIRONMENT` | 20 |
| `PORTAL_FILE` | Path to `apps/web/index.html` if not resolvable from the API's module directory |

### The Fireblocks key is a file

App Platform has no file mounts. The key is passed base64-encoded as
`FIREBLOCKS_SECRET_KEY_B64` and written to disk at boot by
`scripts/write-fireblocks-key.sh`. It is written to `/app/secrets/`, owned by
the `node` user, mode 0600, and never enters the image.

### Do not use the public Solana RPC

`SOLANA_RPC_URL` defaults to `api.mainnet-beta.solana.com` if unset. That
endpoint is aggressively rate-limited and will start rejecting requests under
any real load. When settlement verification cannot reach a node, the engine
correctly refuses to mark transfers complete — so the visible symptom of using
the public endpoint is settlements piling up unproven. Use Helius, Triton,
QuickNode or your own validator. `GET /api/settlement/infra` warns when it is
unset.

## Verifying a deploy

```bash
curl -s https://<app>/api/health

# Books balance?
curl -s -H "Authorization: Bearer $OPS_API_KEY" \
  https://<app>/api/settlement/books/trial-balance

# Can we reach a Solana node?
curl -s -H "Authorization: Bearer $OPS_API_KEY" \
  https://<app>/api/settlement/infra

# Anything stuck? This should be empty.
curl -s -H "Authorization: Bearer $OPS_API_KEY" \
  https://<app>/api/settlement/stuck

# Open exceptions? Every row is something a person must look at.
curl -s -H "Authorization: Bearer $OPS_API_KEY" \
  https://<app>/api/settlement/exceptions

# The certification pack, against this environment's database
DATABASE_URL=… OPS_API_KEY=… npm run certify
```

A deploy is not good because it returned 200 on `/api/health`. It is good when
the trial balance is balanced, `/settlement/stuck` is empty, `/settlement/exceptions`
has no CRITICAL item, `/settlement/infra` reports a reachable dedicated node, and
`npm run certify` passes.

## Running two instances

`instance_count: 2` means two copies of the settlement resume worker. That is
safe: every leg carries a deterministic `externalKey` that is passed to the
partner as an idempotency key, so a duplicated attempt is recognised as a
repeat rather than creating a second payment.

What it is not is *efficient* — both instances may call the same partner for
the same leg. If that becomes noticeable, add `SELECT … FOR UPDATE SKIP
LOCKED` to the due-legs query in `resume.worker.ts`. The correctness argument
does not change; only the efficiency one does.

## Operational routine

| When | What |
|---|---|
| Every deploy | trial balance, `/settlement/stuck`, `/settlement/exceptions`, `/settlement/infra`, `npm run certify` |
| Start of day | `/settlement/stuck` empty; exception queue reviewed in the operator console (Alerts) |
| Close of day | `POST /settlement/reconcile` FULL; suspense zero; no CRITICAL exception open |
| Each approval | Approvals screen: destination (address or participant) and policy checks read before approving |
| Daily | `POST /api/settlement/reconcile` with `{"kind":"FULL"}` |
| Daily | Suspense must be zero. A non-zero suspense balance is a customer debited and not delivered. |
| Weekly | `GET /api/settlement/providers/health` — success rate is over payouts, not quotes |

`/settlement/stuck` is the queue that must be empty at the start of each day.
Every row in it is customer money in an indeterminate state, and no amount of
retrying will clear it — each one needs a person.
