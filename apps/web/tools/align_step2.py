#!/usr/bin/env python3
"""Step 2 front-end alignment — re-runnable, explicit replacements, fails loudly on a missing anchor.
Run from apps/web:  python3 tools/align_step2.py
Each slice of Step 2 appends its own block here so the site always mirrors what the API does."""
import sys
src = open('index.html', encoding='utf-8').read()

def rep(old, new, count=1, marker=None):
    """Replace once. Idempotent: if `old` is gone and `new` (or `marker`, a stable fragment that a later
    slice may have reworded) is present, the change is already in."""
    global src
    if new in src or (marker and marker in src): return  # already applied (checked first: `old` may be a substring of `new`)
    if old not in src: sys.exit(f'anchor missing: {old[:80]!r}')
    src = src.replace(old, new, count)

# ── Slice 1: wallets are live ───────────────────────────────────────────────
rep("""    ['GET','/custody/wallet','Vault balance, available, held','planned'],
    ['GET','/custody/deposit-address','Deposit address per asset (USDC, USDT) for this environment','planned'],""",
"""    ['GET','/wallets','Your wallets in this environment: custody vault, deposit address, balance per asset','live'],
    ['GET','/wallets/{id}/balances','Exact balances per asset (USDC_SOL, USDT_SOL) as decimal strings, from the journal','live'],""", marker="['GET','/wallets'")

# Quick-start block gains the live wallet shape
rep("""  var errs="{ \\"error\\": { \\"code\\": \\"UNAUTHORIZED\\", \\"message\\": \\"Invalid or missing API key\\", \\"requestId\\": \\"b849…\\" } }";""",
"""  var walletShape="GET "+base+"/wallets\\nAuthorization: Bearer axlk_"+(ENV==='PRODUCTION'?'live':'test')+"_3d44…   (scope wallets:read)\\n\\n200 OK\\n[{\\n  \\"id\\": \\"wal_…\\", \\"label\\": \\"Treasury\\", \\"status\\": \\"ACTIVE\\", \\"network\\": \\"solana-mainnet\\",\\n  \\"custody\\": { \\"provider\\": \\"fireblocks\\", \\"vaultId\\": \\"…\\" },\\n  \\"depositAddress\\": \\"…\\",            // one address, USDC and USDT\\n  \\"balances\\": [\\n    { \\"asset\\": \\"USDC_SOL\\", \\"available\\": \\"100.123456\\", \\"pending\\": \\"0\\" },\\n    { \\"asset\\": \\"USDT_SOL\\", \\"available\\": \\"0\\", \\"pending\\": \\"0\\" }\\n  ]\\n}]";
  var errs="{ \\"error\\": { \\"code\\": \\"UNAUTHORIZED\\", \\"message\\": \\"Invalid or missing API key\\", \\"requestId\\": \\"b849…\\" } }";""", marker='var walletShape=')

rep("""   '<div class="chart-card"><h4 style="margin-bottom:14px">Endpoints</h4><div style="display:flex;flex-direction:column;gap:8px;font-size:12.5px">'+ep+'</div></div></div>'+""",
"""   '<div class="chart-card"><h4 style="margin-bottom:14px">Endpoints</h4><div style="display:flex;flex-direction:column;gap:8px;font-size:12.5px">'+ep+'</div></div></div>'+
   '<div class="chart-card reveal d1" style="margin-bottom:14px"><h4 style="margin-bottom:6px">Wallets — live</h4><div style="font-size:12px;color:var(--ink-3);margin-bottom:12px">A wallet is your custody vault in this environment. Balances are read from the double-entry journal, never from a cache; amounts are exact decimal strings, assets are identified by network and token contract (USDC_SOL, USDT_SOL), never by ticker alone.</div><pre style="background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:14px;font-size:11.5px;line-height:1.55;overflow-x:auto;color:var(--ink)">'+walletShape+'</pre></div>'+""", marker='Wallets — live')

# Wallet page: per-asset balances in the API's own terms, beside the deposit address
rep("""<div style="font-size:11px;color:var(--ink-3);margin-top:10px">Environment: '+ENV.toLowerCase()+'. Sandbox addresses hold test USDC/USDT only.</div></div>')+'</div>'+""",
"""<div style="font-size:11px;color:var(--ink-3);margin-top:10px">Environment: '+ENV.toLowerCase()+'. Sandbox addresses hold test USDC/USDT only.</div>'+
        '<h4 style="margin:16px 0 8px">Balances by asset <span style="color:var(--ink-3);font-weight:400;font-size:11px">GET /wallets/{id}/balances</span></h4><table style="font-size:12px"><thead><tr><th>Asset</th><th>Available</th><th>Pending</th></tr></thead><tbody>'+
        n.assets.map(function(a){return '<tr><td class="mono" style="color:var(--teal)">'+a.asset+'</td><td class="mono">'+a.available+'</td><td class="mono" style="color:var(--ink-3)">'+a.pending+'</td></tr>';}).join('')+
        '</tbody></table><div style="font-size:11px;color:var(--ink-3);margin-top:8px">Exact decimal strings from the journal; the USD figures above are these at 1.00.</div></div>')+'</div>'+""", marker='Balances by asset')

rep("""DATA.custody = {
  balance: 48250000, available: 41800000, locked: 6450000,""",
"""DATA.custody = {
  balance: 48250000, available: 41800000, locked: 6450000,
  // Shape of GET /wallets/{id}/balances — illustrative values
  assets:[{asset:'USDC_SOL',available:'21900000.000000',pending:'3200000.000000'},{asset:'USDT_SOL',available:'19900000.000000',pending:'3250000.000000'}],""", marker="assets:[{asset:'USDC_SOL'")

open('index.html', 'w', encoding='utf-8').write(src)
print('step-2 alignment applied')

# ── Slice 2: deposit instructions, settlement status, institution webhooks are live ──
src = open('index.html', encoding='utf-8').read()
rep("""    ['POST','/settlements','Settle to a whitelisted counterparty (USDC or USDT) or a fiat beneficiary','planned'],
    ['GET','/settlements/{id}','Status: PROCESSING · COMPLETED · FAILED, with on-chain proof','planned'],""",
"""    ['POST','/deposits/instructions','Announce an incoming USDC/USDT deposit to a wallet: returns the deposit address and a tracking id','live'],
    ['GET','/settlements/{id}','Status: PROCESSING · COMPLETED · FAILED, with custody proof and on-chain finality','live'],
    ['POST','/settlements','Settle to a whitelisted counterparty (USDC or USDT) or a fiat beneficiary','planned'],""", marker="['POST','/deposits/instructions'")
rep("""    ['POST','/webhooks/endpoints','Register a signed webhook endpoint','planned']""",
"""    ['POST','/webhooks/endpoints','Register a signed webhook endpoint (secret shown once); events deposit.settled · deposit.expired','live']""", marker="['POST','/webhooks/endpoints','Signed")
rep("""  var sig="X-AxLink-Signature: t=1762400000,v1=<hex HMAC-SHA256(secret, t + \\".\\" + body)>\\nX-AxLink-Event-Id: evt_…    (store it; duplicates are redelivered)\\n\\n{ \\"id\\": \\"evt_…\\", \\"type\\": \\"settlement.completed\\", \\"data\\": { \\"settlementId\\": \\"…\\", \\"txHash\\": \\"…\\" } }";""",
"""  var sig="X-AxLink-Signature: t=1762400000,v1=<hex HMAC-SHA256(secret, t + \\".\\" + body)>\\nX-AxLink-Event-Id: evt_…    (store it; duplicates are redelivered)\\n\\n{ \\"id\\": \\"evt_…\\", \\"type\\": \\"deposit.settled\\",\\n  \\"data\\": { \\"settlementId\\": \\"…\\", \\"kind\\": \\"DEPOSIT\\", \\"status\\": \\"COMPLETED\\", \\"walletId\\": \\"wal_…\\",\\n            \\"asset\\": \\"USDC_SOL\\", \\"amount\\": \\"12.5\\", \\"reference\\": \\"INV-2\\", \\"txHash\\": \\"…\\" } }";
  var depositShape="POST "+base+"/deposits/instructions   (scope deposits:write)\\n{ \\"walletId\\": \\"wal_…\\", \\"asset\\": \\"USDC_SOL\\", \\"amount\\": \\"12.5\\", \\"reference\\": \\"INV-2\\" }\\n\\n201 Created\\n{ \\"id\\": \\"dep…\\", \\"kind\\": \\"DEPOSIT\\", \\"status\\": \\"PROCESSING\\",\\n  \\"depositAddress\\": \\"…\\",          // send here, on Solana\\n  \\"trackingId\\": \\"dep_…\\",           // put this in the transfer's external id\\n  \\"expiresAt\\": \\"…\\", \\"proof\\": null }\\n\\nGET "+base+"/settlements/{id}   →  after the custody receipt\\n{ \\"status\\": \\"COMPLETED\\", \\"receivedAmount\\": \\"12.5\\",\\n  \\"proof\\": { \\"custodyTxId\\": \\"…\\", \\"txHash\\": \\"…\\", \\"explorerUrl\\": \\"https://solscan.io/tx/…\\",\\n             \\"finality\\": \\"CUSTODY_CONFIRMED\\" | \\"ON_CHAIN_FINALIZED\\" } }";""", marker="var depositShape=")
rep("""   '<div class="chart-card reveal d1" style="margin-bottom:14px"><h4 style="margin-bottom:6px">Wallets — live</h4>""",
"""   '<div class="chart-card reveal d1" style="margin-bottom:14px"><h4 style="margin-bottom:6px">Deposits and settlement status — live</h4><div style="font-size:12px;color:var(--ink-3);margin-bottom:12px">Announce the deposit, send to the address with the tracking id, read the status. A receipt credits only when asset, amount and wallet match the instruction exactly; custody confirmation and on-chain finality are reported separately, never conflated.</div><pre style="background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:14px;font-size:11.5px;line-height:1.55;overflow-x:auto;color:var(--ink)">'+depositShape+'</pre></div>'+
   '<div class="chart-card reveal d1" style="margin-bottom:14px"><h4 style="margin-bottom:6px">Wallets — live</h4>""", marker='Deposits and settlement status — live')
rep("""  var rows=[['evt_8f21','settlement.completed','200','2 min ago','Delivered'],['evt_8f1c','settlement.processing','200','2 min ago','Delivered'],['evt_8e90','deposit.credited','503 → retry in 5m','14 min ago','Pending'],['evt_8d77','counterparty.approved','200','1 hr ago','Delivered']]""",
"""  var rows=[['evt_8f21','deposit.settled','200','2 min ago','Delivered'],['evt_8f1c','deposit.settled','200','9 min ago','Delivered'],['evt_8e90','deposit.expired','503 → retry in 5m','14 min ago','Pending'],['evt_8d77','deposit.settled','200','1 hr ago','Delivered']]""", marker="['evt_8f21','deposit.settled'")
# Client deposit modal describes the instruction flow in the API's terms
rep("""     '<p class="lead" style="font-size:13.5px;margin-bottom:20px">Send USDC or USDT on Solana to your vault address, or wire fiat and AxLink converts it through its liquidity providers.</p>'+
     '<div class="field"><label>Method</label><select><option>USDC on-chain → vault deposit address</option><option>USDT on-chain → vault deposit address</option><option>USD wire → converted to USDC or USDT</option></select></div>'+
     '<div class="field"><label>Amount (USD)</label><input placeholder="5,000,000" value="5,000,000"/><div class="hint">Credited after on-chain finality · no deposit fee</div></div>'+""",
"""     '<p class="lead" style="font-size:13.5px;margin-bottom:20px">Announce the exact amount you will send; AxLink gives you the wallet address and a tracking id to put in the transfer. The receipt credits only when asset and amount match.</p>'+
     '<div class="field"><label>Asset</label><select><option>USDC_SOL · USDC on Solana</option><option>USDT_SOL · USDT on Solana</option></select></div>'+
     '<div class="field"><label>Amount (exact, in the asset)</label><input placeholder="5000000.000000" value="5000000.000000"/><div class="hint">Instruction valid 72 h · credited on custody receipt · no deposit fee</div></div>'+
     '<div class="field"><label>Your reference</label><input placeholder="INV-2026-0142"/></div>'+""", marker="Your reference")
rep("""onclick="closeModal();toast(\\'Deposit expected — $5,000,000\\')">Create deposit</button>""",
"""onclick="closeModal();toast(\\'Deposit instruction created — tracking id dep_…\\')">Create instruction</button>""", marker="Create instruction</button>")
open('index.html', 'w', encoding='utf-8').write(src)
print('slice 2 applied')

# ── Slice 2b: tighten endpoint copy for the narrow column; quick-start shows real scopes ──
src = open('index.html', encoding='utf-8').read()
rep("['GET','/wallets','Your wallets in this environment: custody vault, deposit address, balance per asset','live']", "['GET','/wallets','Wallets: vault, deposit address, balances','live']")
rep("['GET','/wallets/{id}/balances','Exact balances per asset (USDC_SOL, USDT_SOL) as decimal strings, from the journal','live']", "['GET','/wallets/{id}/balances','Exact balance per asset, from the journal','live']")
rep("['POST','/deposits/instructions','Announce an incoming USDC/USDT deposit to a wallet: returns the deposit address and a tracking id','live']", "['POST','/deposits/instructions','Announce a deposit: address + tracking id','live']")
rep("['GET','/settlements/{id}','Status: PROCESSING · COMPLETED · FAILED, with custody proof and on-chain finality','live']", "['GET','/settlements/{id}','PROCESSING · COMPLETED · FAILED, with proof','live']")
rep("['POST','/webhooks/endpoints','Register a signed webhook endpoint (secret shown once); events deposit.settled · deposit.expired','live']", "['POST','/webhooks/endpoints','Signed webhooks: deposit.settled · deposit.expired','live']", marker="'/webhooks/endpoints','Signed")
rep("""\\"scopes\\": [\\"settlement:*\\", \\"custody:read\\"],\\n  \\"assets\\": [\\"USDC\\", \\"USDT\\"]""", """\\"scopes\\": [\\"wallets:read\\", \\"deposits:write\\", \\"settlements:read\\", \\"webhooks:write\\"]""")
open('index.html', 'w', encoding='utf-8').write(src)
print('slice 2b applied')

# ── Slice 2c: custody receipt ≠ finality; four deposit events ──
src = open('index.html', encoding='utf-8').read()
rep("""GET "+base+"/settlements/{id}   →  after the custody receipt\\n{ \\"status\\": \\"COMPLETED\\", \\"receivedAmount\\": \\"12.5\\",\\n  \\"proof\\": { \\"custodyTxId\\": \\"…\\", \\"txHash\\": \\"…\\", \\"explorerUrl\\": \\"https://solscan.io/tx/…\\",\\n             \\"finality\\": \\"CUSTODY_CONFIRMED\\" | \\"ON_CHAIN_FINALIZED\\" } }";""",
"""GET "+base+"/settlements/{id}\\n  after the custody receipt     →  { \\"status\\": \\"PROCESSING\\", \\"receivedAmount\\": \\"12.5\\", \\"proof\\": { \\"finality\\": \\"CUSTODY_CONFIRMED\\", \\"txHash\\": \\"…\\" } }\\n  after Solana finality         →  { \\"status\\": \\"COMPLETED\\",  \\"proof\\": { \\"finality\\": \\"ON_CHAIN_FINALIZED\\", \\"explorerUrl\\": \\"https://solscan.io/tx/…\\" } }\\n  receipt that could not credit →  { \\"status\\": \\"PROCESSING\\", \\"attention\\": { \\"reason\\": \\"received 12.4 differs from instructed 12.5\\" } }";""")
rep("""['POST','/webhooks/endpoints','Signed webhooks: deposit.settled · deposit.expired','live']""",
"""['POST','/webhooks/endpoints','Signed webhooks: deposit.received · settled · rejected · expired','live']""")
rep("""  var rows=[['evt_8f21','deposit.settled','200','2 min ago','Delivered'],['evt_8f1c','deposit.settled','200','9 min ago','Delivered'],['evt_8e90','deposit.expired','503 → retry in 5m','14 min ago','Pending'],['evt_8d77','deposit.settled','200','1 hr ago','Delivered']]""",
"""  var rows=[['evt_8f21','deposit.settled','200','2 min ago','Delivered'],['evt_8f1c','deposit.received','200','9 min ago','Delivered'],['evt_8e90','deposit.rejected','503 → retry in 5m','14 min ago','Pending'],['evt_8d77','deposit.expired','200','1 hr ago','Delivered']]""")
rep("""\\"type\\": \\"deposit.settled\\",\\n  \\"data\\": { \\"settlementId\\": \\"…\\", \\"kind\\": \\"DEPOSIT\\", \\"status\\": \\"COMPLETED\\", \\"walletId\\": \\"wal_…\\",\\n            \\"asset\\": \\"USDC_SOL\\", \\"amount\\": \\"12.5\\", \\"reference\\": \\"INV-2\\", \\"txHash\\": \\"…\\" } }";""",
"""\\"type\\": \\"deposit.settled\\",\\n  \\"data\\": { \\"settlementId\\": \\"…\\", \\"kind\\": \\"DEPOSIT\\", \\"status\\": \\"COMPLETED\\", \\"finality\\": \\"ON_CHAIN_FINALIZED\\",\\n            \\"walletId\\": \\"wal_…\\", \\"asset\\": \\"USDC_SOL\\", \\"amount\\": \\"12.5\\", \\"reference\\": \\"INV-2\\", \\"txHash\\": \\"…\\" } }\\n\\nEvents: deposit.received (custody confirmed, PROCESSING) · deposit.settled (on-chain finalized, COMPLETED)\\n        deposit.rejected (receipt could not credit — needs attention) · deposit.expired\\nRetries on 5xx / 408 / 429 / timeout: 1m · 5m · 30m · 2h · 12h. Other 4xx are final. Redirects are never followed.";""")
rep("""     '<div class="field"><label>Amount (exact, in the asset)</label><input placeholder="5000000.000000" value="5000000.000000"/><div class="hint">Instruction valid 72 h · credited on custody receipt · no deposit fee</div></div>'+""",
"""     '<div class="field"><label>Amount (exact, in the asset)</label><input placeholder="5000000.000000" value="5000000.000000"/><div class="hint">Instruction valid 72 h · credited on custody receipt · COMPLETED on Solana finality · no deposit fee</div></div>'+""")
open('index.html', 'w', encoding='utf-8').write(src)
print('slice 2c applied')

# ── Slice 3: providers on the ports — operator screen mirrors GET /api/settlement/providers ──
src = open('index.html', encoding='utf-8').read()
rep("""  var rows=[['Custody','Fireblocks · AxLink workspace','custody.primary','vault-treasury, 5 institution vaults','Healthy'],['Blockchain','Solana RPC (dedicated node)','chain.solana','finality proof, balances','Healthy'],['Liquidity','B2BinPay','lp.usd.primary','USDC / USDT ↔ USD / EUR / GBP','Healthy'],['Fiat payout · KES','Choice Bank','door.ke.primary','M-Pesa B2C · PesaLink · RTGS','Healthy'],['Fiat payout · USD','Brainrock','door.us.primary','ACH · wire','Degraded'],['Screening','— (sandbox stub)','screening.primary','names, addresses','Sandbox']]""",
"""  var rows=[['custody','fireblocks','CustodyProvider','vaults, deposit addresses, balances, transfers','Healthy'],['blockchainExecution','fireblocks','CustodyProvider','signing and broadcast through the custodian','Healthy'],['liquidity','b2binpay','LiquidityProvider','USDC / USDT ↔ USD (quotes, orders) — flows authorised separately','Sandbox'],['blockchain · solana-mainnet','solana-mainnet','BlockchainProvider','finality, transaction detail, token balances','Healthy']]""", marker="'CustodyProvider','vaults, deposit addresses")
rep("""<thead><tr><th>Role</th><th>Provider</th><th>Adapter id</th><th>Used for</th><th>Health</th></tr></thead>""",
"""<thead><tr><th>Role</th><th>Provider</th><th>Port</th><th>Used for</th><th>Health</th></tr></thead>""")
rep("""   pageHead('Providers','Every provider is an adapter behind a port. The core names none of them; swapping one is one adapter and one config row.')+""",
"""   pageHead('Providers','Every provider is an adapter behind a port. Nothing under the core names a vendor; swapping one is one adapter registered at boot. This table is GET /api/settlement/providers (operator key): role, adapter, configured or sandbox stub, live health. Fiat payout rails are Leg B and are not registered in this phase.')+""")
open('index.html', 'w', encoding='utf-8').write(src)
print('slice 3 applied')
