# Scope — crypto settlement only

*Set by the owner on 2026-11-06. Binding for every milestone from Step 2 onward.*

AxLink is built as **crypto settlement infrastructure**: digital asset custody, stablecoin deposits
and transfers, cross-chain settlement, liquidity and FX access, bank-to-bank settlement in the asset,
and local fiat payout coordination for receivers that cannot take the asset.

**Out of scope — not built, not integrated, not referenced in new code or docs:**

- The NDD ("Narrow Digital Dollar") settlement leg and any N3XT integration ("Leg B" in the earlier
  two-leg designs). Those designs are reference material only.
- Any issuance or minting of a settlement instrument. AxLink settles existing public stablecoins.

**Where the old scope still shows, and what happens to it:**

| Location | Status |
|---|---|
| `apps/web/index.html` (AxLink front end) | Positions NDD as a rail and has NDD reserve views. Preserved unchanged in Step 1; receives a crypto-settlement-only content pass in the milestone that wires the portal to the API. |
| `docs/ARCHITECTURE.md`, `docs/AxLink-Settlement-Blueprint.*` | Historical. Superseded by `docs/FINANCIAL-MODULES-ARCHITECTURE.md` for anything NDD-related. |
| Backend `src/` | Contains no NDD code. Keep it that way; CI may add a word-guard. |

Providers in scope today: Fireblocks (custody, chain execution), B2BinPay (liquidity), Solana RPC
(finality), plus fiat payout partners for local delivery. All behind `src/providers/ports`.
