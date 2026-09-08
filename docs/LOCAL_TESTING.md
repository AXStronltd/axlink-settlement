# Testing locally before anything goes live

Two ways to exercise the settlement engine without touching a real partner:

| | What it is | When |
|---|---|---|
| **Console** | A page you drive by hand. Press Deposit, watch the legs advance, break the RPC mid-flight, see the books. | Understanding what actually happens; showing someone |
| **Harness** | `npm run simulate` — ten scenarios, asserted, exit code. | Proving it still works; CI |

Both drive the **real engine**: real ledger, real legs, real proof verification.
Only the converter, the custodian and the Solana node are stubbed. If it works
here, the code that would run in production is the code that ran.

---

## Start

```bash
./scripts/dev-up.sh
```

That checks Postgres (starting the `docker compose` one if yours isn't up),
pushes the schema, generates the Prisma client, and starts the server with the
console enabled. It prints a URL with a key in it:

```
Console   http://localhost:4000/console?key=<OPS_API_KEY>
```

Open that. Everything below happens on that page.

---

## A first run, in order

**1 · Start session** — installs the stub rails in the running process. The pill
in the header turns green. Nothing before this point can move.

**2 · Create** a test user. They appear under Balances with nothing.

**3 · Deposit $10,000.** Watch the Settlements row appear and the leg strip fill
in left to right:

```
0 CONVERT_FIAT_TO_CRYPTO   1 CUSTODY_TRANSFER   2 ONCHAIN_SETTLE   3 LEDGER_CREDIT
```

The balance does **not** move until leg 3, and leg 3 does not run until leg 2 has
a finalized signature. That ordering is the whole point.

**4 · Open the Journal** on that row. Two postings, each with a residual of
0.00. That is the double-entry ledger doing its job — and the residual line is
there so you can check it rather than take my word for it.

**5 · Withdraw $5,000.** The legs run, then stop at `PARTNER_PAYOUT` showing
`AWAITING_CONFIRMATION`. **This is correct.** A bank wire is not settled because
an API returned 200. Press **Partner confirms payout** to close it, and watch
`SUSPENSE:USD` return to zero in the Books panel.

---

## Now break it

This is the part worth your time. Each fault is one click, and you can flip it
*mid-settlement*.

### The node goes down

Start a withdrawal, then click **RPC unreachable** before the legs finish, then
**Run worker**.

The `ONCHAIN_SETTLE` leg holds. It does not fail, no proof is written, and the
withdrawal does not complete. Click the fault off, press **Run worker** again —
it settles.

> An unreachable node tells you the call didn't *answer*, not that the transfer
> didn't *happen*. Reversing on a timeout reverses transfers that settled.

### The transaction fails on chain

**Chain tx fails**, then a withdrawal. The leg goes `FAILED` — a different
outcome from above, deliberately — and a proof row is written recording the
on-chain error. Failures are evidence too.

### The chain moved the wrong amount

**Amount drift** makes the chain move 100 USDT less than intended. The signature
still finalizes. The proof is **refused** anyway, because a hash you copied from
an API response isn't evidence unless the mint and amount match.

### Paying twice

Type anything into **Idempotency key** and press Withdraw twice.

The second returns `REPLAYED`, the customer is debited once, and one withdrawal
row exists. Try it with the field blank and you get two real withdrawals — which
is the point of the key.

### Crashing mid-flight

Start a withdrawal and *don't* advance it. Press **Run worker**. The resume
worker picks it up from wherever it stopped, exactly as it would after the
process restarted.

---

## What to watch

Three things in the header, always visible:

- **books balance** — turns red the instant any posting fails to sum to zero
- **invariants hold** — the six checks from the blueprint, re-run on every poll
- **session running** — whether the rails are stubbed

If the books ever break while you're clicking around, **stop and tell me what you
did**. `assertBalanced` refuses unbalanced postings, so a break means a write
reached the database another way — and that is a real bug, not a test artifact.

---

## Then the harness

Once the console makes sense, run the automated version:

```bash
npm run simulate            # all scenarios
npm run simulate -- --list  # what each proves
npm run simulate -- --verbose
```

Ten scenarios, each asserting the global invariants afterwards. Exit code 0 or 1,
so CI can gate on it. `docs/SIMULATOR.md` has the detail.

---

## Cleaning up

**Stop & clean** removes every row the session created — users, deposits,
withdrawals, legs, proofs, journal entries. It deletes exactly its own rows by
id and never truncates.

If a run is interrupted:

```bash
npm run simulate -- --cleanup
```

---

## Safety

The console can move money-shaped value and replace payment rails, so it is
gated four ways:

| Guard | Effect |
|---|---|
| `SIMULATOR_ENABLED=true` | Routes and page are not mounted otherwise |
| `NODE_ENV=production` | Refused outright. No override |
| `OPS_API_KEY` | Every request, including the page's own polling |
| Database check | Refuses a database holding non-simulated users |

The `public/` directory is **not copied into the Docker image**, so the console
cannot exist in a production container even if the env vars were wrong.

---

## If it doesn't start

| Symptom | Cause |
|---|---|
| `Cannot reach Postgres` | Not running, or `DATABASE_URL` points elsewhere. `docker compose up -d db`. |
| `P1010: User was denied access` | A `DATABASE_URL` exported in your shell overrides `.env` — dotenv does not override an already-set variable. `unset DATABASE_URL`, or export the right one inline. |
| `Unauthorized` on the console | Opened without `?key=`. The URL is printed at startup. |
| `no session` and buttons do nothing | Press **Start session** first. |
| Legs stuck at `PENDING` | Faults still on. **Clear all faults**, then **Run worker**. |
| Prisma engine download fails | Corporate network blocking `binaries.prisma.sh`. Engines are cached in `node_modules` after one successful install. |
