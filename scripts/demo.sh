#!/usr/bin/env bash
#
# End-to-end demo against a locally running server.
#
#   npm run dev                 # in another terminal
#   ./scripts/demo.sh
#
# Drives the real API — real ledger, real quotes, real webhooks. The rails are
# stubbed because no credentials are set, but nothing here is narrated: every
# number printed came out of the service.
#
# Two things this does that production would not, both marked [SETUP] below:
#   - approves KYC directly in the database
#   - writes a fake Fireblocks USDT address onto each user
# In production the first is a compliance decision and the second comes from
# Fireblocks when the vault is created.

set -euo pipefail

API="${API:-http://localhost:4000/api}"
# The money-moving endpoints require the platform credential. Local default
# matches the one in .env; override for another environment.
KEY="${SETTLEMENT_API_KEY:-local_dev_settlement_key}"
AUTH=(-H "Authorization: Bearer $KEY")
PSQL_DB="${PSQL_DB:-axlink_settlement}"
PSQL_USER="${PSQL_USER:-$(whoami)}"

jsonf() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
rule()  { printf '\n\033[1m── %s\033[0m\n' "$1"; }
money() { printf '   %-34s %s\n' "$1" "$2"; }

if ! curl -sf -m 5 "$API/health" >/dev/null; then
  echo "No server on $API — run 'npm run dev' first." >&2
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
rule "1. Two customers"

MIKE=$(curl -s "${AUTH[@]}" -X POST "$API/users" -H 'Content-Type: application/json' \
  -d '{"email":"mike+'"$RANDOM"'@demo.test","name":"Mike","currency":"USD"}' | jsonf "d['userId']")
JAMES=$(curl -s "${AUTH[@]}" -X POST "$API/users" -H 'Content-Type: application/json' \
  -d '{"email":"james+'"$RANDOM"'@demo.test","name":"James","currency":"KES"}' | jsonf "d['userId']")

money "Mike   (USA, USD)" "$MIKE"
money "James  (Kenya, KES)" "$JAMES"

MIKE_VAULT=$(psql -h localhost -U "$PSQL_USER" -d "$PSQL_DB" -tAc \
  "SELECT \"vaultId\" FROM \"User\" WHERE id='$MIKE';")
money "Mike's Fireblocks vault" "$MIKE_VAULT"

# [SETUP] Production: KYC is approved by a compliance decision, and usdtAddress
# is returned by Fireblocks when the vault is created.
psql -h localhost -U "$PSQL_USER" -d "$PSQL_DB" -qc \
  "UPDATE \"User\" SET \"kycStatus\"='APPROVED',
     \"usdtAddress\"=COALESCE(\"usdtAddress\",'SoLDemo'||substr(id,1,12))
   WHERE id IN ('$MIKE','$JAMES');"
echo "   [SETUP] KYC approved, USDT vault addresses assigned"

# ─────────────────────────────────────────────────────────────────────────────
rule "2. Mike deposits \$1,000 — fiat in"

DEP=$(curl -s "${AUTH[@]}" -X POST "$API/orchestrator/payout-rail/fiat-arrived" \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$MIKE\",\"currency\":\"USD\",\"amount\":1000,
       \"rail\":\"bank_transfer\",\"railReference\":\"demo_$RANDOM\"}")
TRACK=$(echo "$DEP" | jsonf "d['trackingId']")
money "status" "$(echo "$DEP" | jsonf "d['status']")"
money "flow" "$(echo "$DEP" | jsonf "d['flow']")"

BAL=$(curl -s "${AUTH[@]}" "$API/users/$MIKE" | jsonf "d['accounts'][0]['balance']")
money "Mike's balance now" "\$$BAL   <- still zero, and that is correct"
echo "   The money is not his until USDT is confirmed in his vault."

# ─────────────────────────────────────────────────────────────────────────────
rule "3. Fireblocks confirms the USDT landed"

curl -s -X POST "$API/webhooks/fireblocks" -H 'Content-Type: application/json' \
  -d "{\"type\":\"TRANSACTION_STATUS_UPDATED\",
       \"data\":{\"id\":\"fbtx_$RANDOM\",\"status\":\"COMPLETED\",
                 \"assetId\":\"USDT_SOL\",\"amount\":\"1000\",
                 \"txHash\":\"demo_solana_sig_$RANDOM\",
                 \"externalTxId\":\"$TRACK\",
                 \"destination\":{\"id\":\"$MIKE_VAULT\"}}}" >/dev/null

BAL=$(curl -s "${AUTH[@]}" "$API/users/$MIKE" | jsonf "d['accounts'][0]['balance']")
money "Mike's balance now" "\$$BAL"

# ─────────────────────────────────────────────────────────────────────────────
rule "4. Quote USD -> KES (locked 30s)"

Q=$(curl -s -X POST "$API/quote" -H 'Content-Type: application/json' \
  -d '{"fromCurrency":"USD","toCurrency":"KES","fromAmount":300}')
QID=$(echo "$Q" | jsonf "d['quoteId']")
money "customer rate" "$(echo "$Q" | jsonf "d['rate']")"
money "James receives" "KSh $(echo "$Q" | jsonf "d['to']['amount']")"
money "winning LP" "$(echo "$Q" | jsonf "d['rfq']['winningLP']")"
money "our spread" "$(echo "$Q" | jsonf "d['rfq']['axlinkSpread']")"
money "revenue on this txn" "$(echo "$Q" | jsonf "d['revenueModel']['axlinkRevenue']")"

# ─────────────────────────────────────────────────────────────────────────────
rule "5. Transfer \$300 Mike -> James"

T=$(curl -s "${AUTH[@]}" -X POST "$API/orchestrator/transfer" -H 'Content-Type: application/json' \
  -d "{\"senderId\":\"$MIKE\",\"receiverId\":\"$JAMES\",\"fromCurrency\":\"USD\",
       \"toCurrency\":\"KES\",\"amount\":300,\"quoteId\":\"$QID\"}")
echo "$T" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'error' in d: print('   error:', d['error'])
else:
    for k in ('status','fromAmount','toAmount','rate'):
        if k in d: print(f'   {k:<34} {d[k]}')
" || true

money "Mike's USD"  "$(curl -s "${AUTH[@]}" "$API/users/$MIKE"  | jsonf "d['accounts']")"
money "James's KES" "$(curl -s "${AUTH[@]}" "$API/users/$JAMES" | jsonf "d['accounts']")"

# ─────────────────────────────────────────────────────────────────────────────
rule "6. James withdraws to M-Pesa"

W=$(curl -s "${AUTH[@]}" -X POST "$API/orchestrator/withdraw" -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$JAMES\",\"currency\":\"KES\",\"amount\":5000,
       \"recipientName\":\"James Mwangi\",
       \"destination\":{\"type\":\"mpesa\",\"method\":\"mobile_money\",
                        \"mobileNumber\":\"+254712345678\"}}")
echo "$W" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('   error:', d['error']) if 'error' in d else [
  print(f'   {k:<34} {d[k]}') for k in ('trackingId','status','currency','amount') if k in d]
" || true

# ─────────────────────────────────────────────────────────────────────────────
rule "7. What the books say"

psql -h localhost -U "$PSQL_USER" -d "$PSQL_DB" -c \
  "SELECT \"entityType\", event, \"createdAt\"::time(0)
     FROM \"AuditLog\" ORDER BY \"createdAt\" DESC LIMIT 12;"

echo
echo "Ledger accounts (journal side):"
psql -h localhost -U "$PSQL_USER" -d "$PSQL_DB" -c \
  "SELECT code, type, balance, currency FROM \"LedgerAccount\" ORDER BY code;" 2>/dev/null || true

printf '\n\033[1mDone.\033[0m Re-run any time — each run creates fresh users.\n'
