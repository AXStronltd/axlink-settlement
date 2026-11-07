#!/usr/bin/env python3
"""Client-facing wording in the bank dashboard (owner review 2026-11-07). Re-runnable; fails loudly on a missing anchor.
Run from apps/web:  python3 tools/client_copy_v1.py
- the network is the one the API reports (sandbox = Solana devnet), never a hard-coded 'solana-mainnet';
- API paths (GET/POST /v1/…) leave client screens and dialogs — they stay on the Developers page;
- every dashboard page states plainly when it is the sandbox (test tokens, no real money)."""
import sys
src = open('index.html', encoding='utf-8').read()

def rep(old, new, marker=None):
    global src
    if (marker or new) in src: return
    if old not in src: sys.exit(f'anchor missing: {old[:90]!r}')
    src = src.replace(old, new, 1)

# helper: friendly network name from what the API reports
rep("function liveAmt(a){",
"""function axNet(){
  var n=(LIVE.assets&&LIVE.assets.networks&&LIVE.assets.networks[0]&&LIVE.assets.networks[0].id)||((LIVE.wallets||[])[0]||{}).network||'';
  return n==='solana-devnet'?'Solana devnet (sandbox, test tokens)':n==='solana-mainnet'?'Solana mainnet':'Solana';
}
function liveAmt(a){""", "function axNet(){")

# sandbox banner (keeps the 'Live · <slug> · sandbox' prefix), no API base URL
rep("""<span>&#9679; Live · '+LIVE.me.institution.slug+' · '+LIVE.me.environment.toLowerCase()+' · '+liveEsc(axBase())+(LIVE.error?""",
    """<span>&#9679; Live · '+LIVE.me.institution.slug+' · '+LIVE.me.environment.toLowerCase()+(LIVE.me.environment==='SANDBOX'?' · <b style="color:var(--amber)">Sandbox: test tokens on Solana devnet, no real money</b>':'')+(LIVE.error?""")

# wallet screen + new-wallet dialog
rep("""'Your custody vaults in '+LIVE.me.environment.toLowerCase()+'. Balances are read from the double-entry journal (GET /v1/balances), never from a cache.'""",
    """'Your custody vaults on '+axNet()+'. Balances come from the double-entry ledger, never from a cache.'""")
rep("tableCard('Wallets — GET /v1/wallets',", "tableCard('Wallets',")
rep("tableCard('Deposit instructions — GET /v1/deposits',", "tableCard('Deposit instructions',")
rep("""POST /v1/wallets — a custody vault on solana-mainnet with one deposit address for USDC and USDT.""",
    """Creates a dedicated custody vault (Fireblocks) on '+axNet()+', with one deposit address for USDC and USDT.""")
# deposit dialog
rep("""<div class="hint">POST /v1/deposits — returns the address and a tracking id to put in the sender\\'s transfer.</div>""",
    """<div class="hint">You get the deposit address and a tracking id. Send exactly the announced amount; it is credited once, when Solana confirms it.</div>""")
# settlements
rep("""'Outbound settlements from your wallet to an approved counterparty — GET /v1/transfers. COMPLETED only when a Solana node reports the transfer finalized.'""",
    """'Settlements from your wallet to an approved counterparty. Completed only when Solana reports the transfer final.'""")
rep("""<div class="hint">POST /v1/transfers with an Idempotency-Key · above the approval threshold it waits for an operator.""",
    """<div class="hint">Safe to retry: the same settlement is never sent twice. Large settlements wait for AxLink approval.""")
# counterparties
rep("""'Who you may settle to — GET /v1/counterparties. """, """'Who you may settle to. """)
rep("""<div class="hint">POST /v1/counterparties — AxLink\\'s own custody wallets are refused here.</div>""",
    """<div class="hint">AxLink\\'s own custody wallets cannot be added here.</div>""")
# webhooks
rep("""'Signed event deliveries for '+LIVE.me.environment.toLowerCase()+' — GET /v1/webhook-endpoints. """,
    """'Signed event deliveries for '+LIVE.me.environment.toLowerCase()+'. """)
rep("""<div class="hint">POST /v1/webhook-endpoints — the signing secret is shown once.""",
    """<div class="hint">The signing secret is shown once.""")
# statement + balances
rep("""'Your statement, straight from the double-entry journal — GET /v1/ledger/entries. """, """'Your statement, straight from the double-entry ledger. """)
rep("""'Journal-derived, exact decimals, per asset and per wallet — GET /v1/balances. """, """'From the ledger, exact decimals, per asset and per wallet. """)

open('index.html', 'w', encoding='utf-8').write(src)
print('client copy v1 applied')
