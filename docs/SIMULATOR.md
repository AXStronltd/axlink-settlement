# Settlement harness

Runs **real settlements through the real engine** — real ledger, real legs, real
proof verification, real invariant checks — against a converter, custodian and
Solana node it can make misbehave on demand.

Nothing here re-implements settlement logic. If a scenario passes, the code that
would run in production is the code that ran; only the three external systems
were replaced.

```bash
SIMULATOR_ENABLED=true npm run simulate
```

> Not the same thing as `src/routes/simulate.routes.ts`. That builds an
> illustrative step-by-step narrative for the frontend with hard-coded rates and
> never touches the engine. This exercises it.

## What it proves

```
npm run simulate -- --list
```

| Scenario | What a pass tells you |
|---|---|
| `deposit-happy` | Legs run in order and the balance moves only after a finalized signature |
| `deposit-ordering` | **No USDT payout is requested before the conversion confirms** — the sequencing bug stays fixed |
| `withdrawal-happy` | Suspense holds the money between debit and delivery; only the partner's confirmation closes it |
| `rpc-unreachable` | An unreachable node is not a failed settlement. The leg holds and completes when the node returns |
| `onchain-failure` | A transaction that lands and fails **is** a failed settlement, and the error is recorded |
| `amount-drift` | A finalized signature is refused as proof when the mint or amount doesn't match |
| `duplicate-request` | One idempotency key pays once; the replay returns the original |
| `concurrent-duplicate` | Two simultaneous identical requests produce one payment |
| `crash-resume` | A settlement abandoned mid-flight is finished by the resume worker, without paying twice |
| `insufficient-balance` | An overdraw is refused whole, leaving no partial state |

Every scenario also asserts the global invariants from
`docs/GAP_ANALYSIS.md`, whether or not its own claim held:

- **I-1** trial balance is zero in every currency
- **I-2** nothing is `COMPLETED` without a finalized on-chain proof
- **I-3** suspense is flat — nothing debited and undelivered
- **I-4** `Account.balance` agrees with the journal
- **I-8** no leg has exhausted its retry budget
- **S-1** every journal entry has at least two sides

A scenario that passes its own expectation while breaking an invariant fails.
That is the point: a deposit reaching `COMPLETED` proves very little, and the
books are as likely to be wrong on the happy path as on a failure.

## Usage

```bash
npm run simulate                              # everything
npm run simulate -- --only rpc-unreachable    # one scenario
npm run simulate -- --only deposit-happy,crash-resume
npm run simulate -- --verbose                 # journal postings + passing invariants
npm run simulate -- --keep                    # leave the data to inspect
npm run simulate -- --cleanup                 # remove data from an interrupted run
npm run simulate -- --json                    # machine-readable report
```

Exits `0` when everything passed, `1` on a failure, `2` when a safety guard
refused the run.

## Safety

This deliberately stubs out the payment rails and writes to a database, so it
refuses to run unless it is clearly meant to:

| Guard | Behaviour |
|---|---|
| `NODE_ENV=production` | Refuses. No override. |
| `SIMULATOR_ENABLED` not `true` | Refuses. Set it only where stubbing rails is intended. |
| Database holds non-simulated users | Refuses, unless `SIMULATOR_ALLOW_POPULATED_DB=true` |

Everything it creates is prefixed `sim_` and tracked by id, and cleanup deletes
exactly those rows in dependency order. **It never truncates** — a cleanup
broader than the run is its own kind of incident.

The port override in `src/core/ports.ts` enforces the first two guards
independently of the runner, so no other code path can reach a state where the
live providers have been quietly replaced.

## Over HTTP

For proving a deployed sandbox works — right database, migrations applied,
credentials the right shape — without shelling in. Mounted only when
`SIMULATOR_ENABLED=true` and `NODE_ENV` is not production, and gated by
`OPS_API_KEY`.

```bash
curl -s -H "Authorization: Bearer $OPS_API_KEY" \
  https://<app>/api/settlement/harness/scenarios

curl -s -X POST -H "Authorization: Bearer $OPS_API_KEY" \
  -H 'content-type: application/json' -d '{"only":["deposit-happy"]}' \
  https://<app>/api/settlement/harness/run
```

`/run` returns **200** when everything passed and **422** when anything failed,
so a CI check can gate on the status code without parsing the body.

## How the seam works

`src/core/ports.ts` is the only place the engine reaches outside itself:

```
ports().converter  createDeposit · createPayout
ports().custody    createTransfer · getTransaction · getVaultAssetBalance
ports().chain      awaitFinality · getTransaction · getSignatureStatus · getTokenBalanceRaw
```

Live implementations are the default; nothing changes at runtime. The port
shapes mirror the live signatures exactly rather than inventing a neutral
interface — a port that reshapes its provider's API is a place for the two to
drift apart silently.

`src/simulator/stubs.ts` holds the stand-ins. They are not "return a canned
value" mocks: they keep enough state to behave coherently across a multi-leg
settlement. A payout requested twice with the same idempotency key returns the
*same* payment; a custody transfer with the same `externalTxId` returns the
*same* transaction. Those properties are what make resuming safe, so the stubs
enforce them rather than assuming them.

## Adding a scenario

Add an entry to `SCENARIOS` in `src/simulator/scenarios.ts`:

```ts
{
  id: 'converter-timeout',
  title: 'The converter times out on the payout leg',
  proves: 'A timeout is not a confirmed failure — the leg is retried, not reversed.',
  async run({ makeUser, world, expect, note, scope }) {
    world.faults.converterTimesOut = true;
    // …
  },
}
```

`proves` is required and appears in the report. A scenario that cannot say what
a pass tells you is a smoke test, and smoke tests are how a suite ends up green
while the thing it covers is broken.

Available faults are the `Faults` interface in `stubs.ts`: `chainUnreachable`,
`chainExecutionError`, `finalityDelayPolls`, `chainAmountDrift`,
`custodyNeverBroadcasts`, `custodyFails`, `converterFails`, `converterTimesOut`.

## In CI

The harness needs a database and a generated Prisma client, both of which the
existing `backend` job already sets up. Add after the test step:

```yaml
      - name: Settlement harness
        run: npm run simulate
        env:
          SIMULATOR_ENABLED: 'true'
          DATABASE_URL: postgresql://fincruise:fincruise@localhost:5432/fincruise_test
```
