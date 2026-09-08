# Deploying to DigitalOcean

## Before the first deploy: create the migration baseline

**This repository has no `prisma/migrations/` directory.** `CLAUDE.md` documents
the workaround — use `prisma db push` — which is fine on a laptop and wrong for a
production database that moves customer money. There is no schema history, no
review of schema changes, no rollback, and `prisma migrate deploy` in a pipeline
silently does nothing at all, so a deploy appears to succeed against a database
that never migrated.

Generate the baseline once, on your Mac:

```bash
./scripts/create-baseline-migration.sh
git add prisma/migrations
git commit -m "Add migration baseline"
```

> This could not be run for you. Prisma downloads its engine binaries from
> `binaries.prisma.sh`, which is blocked by egress policy in both the cloud
> workspace and the sandboxed Linux VM (403 from the proxy on every attempt).
> Your Mac already has the `darwin-arm64` engines in `node_modules`, so the
> script works there natively. It is one command.

After that, every schema change follows the normal flow:

```bash
npx prisma migrate dev --name describe_the_change
```

## Deploy

```bash
doctl apps create --spec .do/app.yaml            # first time
doctl apps update <APP_ID> --spec .do/app.yaml   # afterwards
```

The spec provisions managed Postgres 16, runs `prisma migrate deploy` as a
`PRE_DEPLOY` job, then rolls out the API and the static frontend.

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
| `OPS_API_KEY` | Gates every `/api/settlement/*` route except the public proof endpoint |
| `RECON_ONCHAIN_ADDRESSES` | `label=address,label=address` |

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
```

A deploy is not good because it returned 200 on `/api/health`. It is good when
the trial balance is balanced, `/settlement/stuck` is empty, and
`/settlement/infra` reports a reachable node.

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
| Every deploy | trial balance, `/settlement/stuck`, `/settlement/infra` |
| Daily | `POST /api/settlement/reconcile` with `{"kind":"FULL"}` |
| Daily | Suspense must be zero. A non-zero suspense balance is a customer debited and not delivered. |
| Weekly | `GET /api/settlement/providers/health` — success rate is over payouts, not quotes |

`/settlement/stuck` is the queue that must be empty at the start of each day.
Every row in it is customer money in an indeterminate state, and no amount of
retrying will clear it — each one needs a person.
