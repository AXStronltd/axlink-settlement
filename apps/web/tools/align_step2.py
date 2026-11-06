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
    ['GET','/wallets/{id}/balances','Exact balances per asset (USDC_SOL, USDT_SOL) as decimal strings, from the journal','live'],""", marker="'/wallets'")

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
    ['POST','/settlements','Settle to a whitelisted counterparty (USDC or USDT) or a fiat beneficiary','planned'],""", marker="'/settlements/{id}','PROCESSING")
rep("""    ['POST','/webhooks/endpoints','Register a signed webhook endpoint','planned']""",
"""    ['POST','/webhooks/endpoints','Register a signed webhook endpoint (secret shown once); events deposit.settled · deposit.expired','live']""", marker="'Signed webhooks: deposit")
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
rep("['GET','/wallets','Your wallets in this environment: custody vault, deposit address, balance per asset','live']", "['GET','/wallets','Wallets: vault, deposit address, balances','live']", marker="'/custody/deposit-addresses'")
rep("['GET','/wallets/{id}/balances','Exact balances per asset (USDC_SOL, USDT_SOL) as decimal strings, from the journal','live']", "['GET','/wallets/{id}/balances','Exact balance per asset, from the journal','live']", marker="'/custody/deposit-addresses'")
rep("['POST','/deposits/instructions','Announce an incoming USDC/USDT deposit to a wallet: returns the deposit address and a tracking id','live']", "['POST','/deposits/instructions','Announce a deposit: address + tracking id','live']", marker="'/custody/deposit-addresses'")
rep("['GET','/settlements/{id}','Status: PROCESSING · COMPLETED · FAILED, with custody proof and on-chain finality','live']", "['GET','/settlements/{id}','PROCESSING · COMPLETED · FAILED, with proof','live']", marker="'/custody/deposit-addresses'")
rep("['POST','/webhooks/endpoints','Register a signed webhook endpoint (secret shown once); events deposit.settled · deposit.expired','live']", "['POST','/webhooks/endpoints','Signed webhooks: deposit.settled · deposit.expired','live']", marker="'Signed webhooks: deposit")
rep("""\\"scopes\\": [\\"settlement:*\\", \\"custody:read\\"],\\n  \\"assets\\": [\\"USDC\\", \\"USDT\\"]""", """\\"scopes\\": [\\"wallets:read\\", \\"deposits:write\\", \\"settlements:read\\", \\"webhooks:write\\"]""", marker="wallets:write")
open('index.html', 'w', encoding='utf-8').write(src)
print('slice 2b applied')

# ── Slice 2c: custody receipt ≠ finality; four deposit events ──
src = open('index.html', encoding='utf-8').read()
rep("""GET "+base+"/settlements/{id}   →  after the custody receipt\\n{ \\"status\\": \\"COMPLETED\\", \\"receivedAmount\\": \\"12.5\\",\\n  \\"proof\\": { \\"custodyTxId\\": \\"…\\", \\"txHash\\": \\"…\\", \\"explorerUrl\\": \\"https://solscan.io/tx/…\\",\\n             \\"finality\\": \\"CUSTODY_CONFIRMED\\" | \\"ON_CHAIN_FINALIZED\\" } }";""",
"""GET "+base+"/settlements/{id}\\n  after the custody receipt     →  { \\"status\\": \\"PROCESSING\\", \\"receivedAmount\\": \\"12.5\\", \\"proof\\": { \\"finality\\": \\"CUSTODY_CONFIRMED\\", \\"txHash\\": \\"…\\" } }\\n  after Solana finality         →  { \\"status\\": \\"COMPLETED\\",  \\"proof\\": { \\"finality\\": \\"ON_CHAIN_FINALIZED\\", \\"explorerUrl\\": \\"https://solscan.io/tx/…\\" } }\\n  receipt that could not credit →  { \\"status\\": \\"PROCESSING\\", \\"attention\\": { \\"reason\\": \\"received 12.4 differs from instructed 12.5\\" } }";""")
rep("""['POST','/webhooks/endpoints','Signed webhooks: deposit.settled · deposit.expired','live']""",
"""['POST','/webhooks/endpoints','Signed webhooks: deposit.received · settled · rejected · expired','live']""", marker="'Signed webhooks: deposit.received")
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

# ── Slice 4: /api/v1 institution contract (Architecture Blueprint names) — Developers page ──
src = open('index.html', encoding='utf-8').read()
rep("""  var base=(ENV==='PRODUCTION')?'https://api.axlink.network/api':'https://sandbox.api.axlink.network/api';""",
"""  var base=(ENV==='PRODUCTION')?'https://api.axlink.network/api/v1':'https://sandbox.api.axlink.network/api/v1';""")
rep("""\\"scopes\\": [\\"wallets:read\\", \\"deposits:write\\", \\"settlements:read\\", \\"webhooks:write\\"]\\n}";""",
"""\\"scopes\\": [\\"wallets:read\\", \\"wallets:write\\", \\"deposits:write\\", \\"deposits:read\\", \\"settlements:read\\", \\"ledger:read\\", \\"webhooks:write\\"]\\n}";""", marker="counterparties:write")
rep("""  var ep=[
    ['GET','/institutions/me','Identify the calling institution and environment','live'],
    ['GET','/health · /ready','Liveness and readiness','live'],
    ['GET','/wallets','Wallets: vault, deposit address, balances','live'],
    ['GET','/wallets/{id}/balances','Exact balance per asset, from the journal','live'],
    ['POST','/deposits/instructions','Announce a deposit: address + tracking id','live'],
    ['GET','/settlements/{id}','PROCESSING · COMPLETED · FAILED, with proof','live'],
    ['POST','/settlements','Settle to a whitelisted counterparty (USDC or USDT) or a fiat beneficiary','planned'],
    ['POST','/counterparties','Register a counterparty wallet (screened, then approved)','planned'],
    ['POST','/payouts','Local fiat payout where the receiver cannot hold the asset','planned'],
    ['GET','/liquidity/quote','Indicative USDC/USDT ↔ fiat rate, 30 s lock','planned'],
    ['POST','/webhooks/endpoints','Signed webhooks: deposit.received · settled · rejected · expired','live']
  ]""",
"""  var ep=[
    ['GET','/institutions/me','Institution profile, environment and permissions','live'],
    ['GET','/assets','Supported assets and networks (USDC_SOL, USDT_SOL on solana-mainnet)','live'],
    ['POST','/wallets','Provision an institutional wallet (custody vault) · GET lists them','live'],
    ['POST','/custody/deposit-addresses','Request the receiving address of a wallet','live'],
    ['GET','/balances','Institution balances by asset, from the journal','live'],
    ['POST','/deposits','Announce a deposit: tracking id + address · GET status and history','live'],
    ['GET','/settlements/{id}','PROCESSING · COMPLETED · FAILED, with on-chain proof','live'],
    ['GET','/ledger/entries','Authorised ledger history (your custody and liability lines), cursor-paged','live'],
    ['POST','/webhook-endpoints','Signed webhooks: deposit.received · settled · rejected · expired','live'],
    ['POST','/transfers','Initiate a stablecoin transfer to a whitelisted counterparty','next'],
    ['POST','/settlements','Initiate an institutional settlement','next']
  ]""", marker="['POST','/custody/deposit-addresses'")
rep("""(e[3]==='live'?'background:rgba(46,230,197,.12);color:var(--teal)':'')""",
"""(e[3]==='live'?'background:rgba(46,230,197,.12);color:var(--teal)':(e[3]==='next'?'background:rgba(255,196,64,.14);color:#e0a92a':''))""")
rep("""  var depositShape="POST "+base+"/deposits/instructions   (scope deposits:write)""",
"""  var depositShape="POST "+base+"/deposits   (scope deposits:write)""")
open('index.html', 'w', encoding='utf-8').write(src)
print('slice 4 applied')

# ── Slice 5: outbound settlement — Settlements, Counterparties, Approvals, Developers mirror POST /v1/transfers ──
src = open('index.html', encoding='utf-8').read()
rep("""    ['POST','/transfers','Initiate a stablecoin transfer to a whitelisted counterparty','next'],
    ['POST','/settlements','Initiate an institutional settlement','next']""",
"""    ['POST','/counterparties','Register a receiving address (sandbox: active at once · production: operator approval after custody whitelisting)','live'],
    ['POST','/transfers','Settle USDC or USDT to an ACTIVE counterparty — Idempotency-Key required; policy, approval, custody, Solana finality','live'],
    ['POST','/settlements','Same action as POST /transfers (blueprint name) · GET /settlements/{id} answers for deposits and transfers','live']""", marker="['POST','/counterparties','Register a receiving address")
rep("""    ['POST','/webhook-endpoints','Signed webhooks: deposit.received · settled · rejected · expired','live'],""",
"""    ['POST','/webhook-endpoints','Signed webhooks: deposit.received · settled · rejected · expired · transfer.submitted · settled · failed','live'],""")
rep("""\\"scopes\\": [\\"wallets:read\\", \\"wallets:write\\", \\"deposits:write\\", \\"deposits:read\\", \\"settlements:read\\", \\"ledger:read\\", \\"webhooks:write\\"]\\n}";""",
"""\\"scopes\\": [\\"wallets:read\\", \\"wallets:write\\", \\"deposits:write\\", \\"deposits:read\\", \\"settlements:read\\", \\"counterparties:write\\", \\"transfers:write\\", \\"ledger:read\\", \\"webhooks:write\\"]\\n}";""")
# Settlements screen (was "Payments" with fiat/rails): transfers in API terms
rep("""   pageHead('Payments','Send instant settlements to verified counterparties over the stablecoin rail.','<button class="btn btn-ghost btn-sm" onclick="toast(\\'Export started\\')">Export</button><button class="btn btn-primary btn-sm" onclick="openNewPayment()">+ New Payment</button>')+""",
"""   pageHead('Settlements','Outbound settlements: USDC or USDT from your wallet to an approved counterparty. Every one is journaled before custody is called, and COMPLETED only when a Solana node reports it finalized. This screen is GET /v1/transfers.','<button class="btn btn-ghost btn-sm" onclick="toast(\\'Export started\\')">Export</button><button class="btn btn-primary btn-sm" onclick="openNewPayment()">+ New Settlement</button>')+""", marker="This screen is GET /v1/transfers")
rep("""   kpiCard('&#8644;','Payments (24h)','1,284','+8.3%','up',6)+
   kpiCard('&#9670;','Volume (24h)','$248.6M','+12.5%','up',7,'#34d399')+
   kpiCard('&#10003;','Success Rate','99.72%','+0.6%','up',8,'#34d399')+
   kpiCard('&#9683;','Avg Settle','2.3s','instant on-chain','flat',5,'#a78bfa')+'</div>'+
   tableCard('Recent Payments',['ID','Beneficiary','Amount','Currency','Rail','Status','Settle','Time'],rows)""",
"""   kpiCard('&#8644;','Settlements (24h)','1,284','+8.3%','up',6)+
   kpiCard('&#9670;','Volume (24h)','$248.6M','+12.5%','up',7,'#34d399')+
   kpiCard('&#10003;','Finalized on-chain','99.72%','+0.6%','up',8,'#34d399')+
   kpiCard('&#9202;','Awaiting approval','1','operator queue','flat',5,'#fbbf24')+'</div>'+
   tableCard('Recent settlements',['ID','Counterparty','Amount','Asset','Stage','Status','Finality','Time'],rows)+
   '<div class="chart-card reveal d2" style="margin-top:14px"><h4 style="margin-bottom:6px">Lifecycle</h4><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--ink-2)"><span class="chip">AWAITING_APPROVAL</span><span style="color:var(--teal)">&#8594;</span><span class="chip">APPROVED · journaled</span><span style="color:var(--teal)">&#8594;</span><span class="chip">SUBMITTED · custody</span><span style="color:var(--teal)">&#8594;</span><span class="chip">CONFIRMED · txHash</span><span style="color:var(--teal)">&#8594;</span><span class="chip" style="color:var(--teal)">SETTLED · Solana finalized</span></div><div style="font-size:11.5px;color:var(--ink-3);margin-top:10px">Public status is PROCESSING until SETTLED (COMPLETED). A failure before or at custody reverses the journal entry and restores your balance; a disagreement between custody and the chain is never reversed automatically — it is flagged for a person.</div></div>'""", marker="Finalized on-chain")
rep("""  var rows=DATA.payments.map(function(p){return '<tr onclick="openPaymentDetail(\\''+p.id+'\\')" style="cursor:pointer"><td class="txid">'+p.id+'</td><td>'+flag(p.cc)+' '+p.bene+'</td><td>'+p.amount+'</td><td style="color:var(--ink-2)">'+p.cur+'</td><td><span class="chip" style="padding:2px 8px"><span class="d" style="background:'+(p.rail==='USDC'?'var(--teal)':'var(--ink-3)')+'"></span>'+p.rail+'</span></td><td><span class="badge badge-'+(p.status==='Completed'?'completed':p.status==='Failed'?'failed':'pending')+'">'+p.status+'</span></td><td style="color:var(--ink-2)">'+p.settle+'</td><td style="color:var(--ink-3)">'+p.at+'</td></tr>';}).join('');""",
"""  var tr=[['tr_9f21a','Partner Bank · 7xKX…9mQw','120,500.000000','USDC_SOL','SETTLED','COMPLETED','ON_CHAIN_FINALIZED · slot 2,981,114','2 min ago'],['tr_9f1c3','Hormuud Exchange · 4hRt…Lp2e','3,250,000.000000','USDT_SOL','CONFIRMED','PROCESSING','CUSTODY_CONFIRMED','6 min ago'],['tr_9e90d','Partner Bank · 7xKX…9mQw','750,000.000000','USDC_SOL','AWAITING_APPROVAL','PROCESSING','—','14 min ago'],['tr_9d77b','RemitPro · 9Qw1…Zx8c','42,000.000000','USDC_SOL','FAILED','FAILED','journal reversed','1 hr ago']];
  var rows=tr.map(function(p){return '<tr onclick="openPaymentDetail(\\''+p[0]+'\\')" style="cursor:pointer"><td class="txid">'+p[0]+'</td><td>'+p[1]+'</td><td class="mono" style="font-size:12px">'+p[2]+'</td><td style="color:var(--ink-2)">'+p[3]+'</td><td><span class="chip" style="padding:2px 8px">'+p[4]+'</span></td><td><span class="badge badge-'+(p[5]==='COMPLETED'?'completed':p[5]==='FAILED'?'failed':'pending')+'">'+p[5]+'</span></td><td style="color:var(--ink-2);font-size:12px">'+p[6]+'</td><td style="color:var(--ink-3)">'+p[7]+'</td></tr>';}).join('');""", marker="var tr=[['tr_9f21a'")
# New settlement dialog in API terms
rep("""  openModal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px"><h3 style="font-size:19px">New Payment</h3><span style="color:var(--ink-3);cursor:pointer" onclick="closeModal()">x</span></div>'+
   '<div class="field"><label>Verified counterparty</label><select><option>GlobalPay Ltd. (SG) — Identity Passport verified</option><option>RemitPro (IN) — verified</option><option>FinServe Africa (KE) — verified</option><option>PayTech Solutions (AE) — verified</option></select><div class="hint">Only KYC/KYB-verified parties on the network are selectable.</div></div>'+
   '<div class="grid-2" style="gap:14px"><div class="field"><label>Amount</label><input placeholder="250,000" value="250,000"/></div><div class="field"><label>Currency</label><select><option>USD</option><option>EUR</option><option>GBP</option><option>USDC</option><option>USDT</option></select></div></div>'+
   '<div class="field"><label>Settlement rail</label><select><option>On-chain USDC — instant (recommended)</option><option>On-chain USDT — instant</option><option>Local fiat payout — domestic rail</option></select></div>'+
   '<div class="field"><label>Reference</label><input placeholder="Invoice #INV-2026-0442"/></div>'+
   '<div style="display:flex;gap:10px;margin-top:8px"><button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="closeModal();toast(\\'Payment sent to verified counterparty\\')">Send Payment</button></div>');""",
"""  openModal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px"><h3 style="font-size:19px">New Settlement</h3><span style="color:var(--ink-3);cursor:pointer" onclick="closeModal()">x</span></div>'+
   '<div class="field"><label>From wallet</label><select><option>Main — solana-mainnet · USDC 21,900,000.000000 · USDT 19,900,000.000000</option></select></div>'+
   '<div class="field"><label>Counterparty (ACTIVE only)</label><select><option>Partner Bank — 7xKX…9mQw (approved, custody whitelisted)</option><option>Hormuud Exchange — 4hRt…Lp2e (approved)</option></select><div class="hint">Only counterparties approved for this environment are selectable; a pending one cannot receive.</div></div>'+
   '<div class="grid-2" style="gap:14px"><div class="field"><label>Amount (exact, in the asset)</label><input placeholder="250000.000000" value="250000.000000"/></div><div class="field"><label>Asset</label><select><option>USDC_SOL</option><option>USDT_SOL</option></select></div></div>'+
   '<div class="field"><label>Your reference</label><input placeholder="SETTLE-2026-0442"/><div class="hint">POST /v1/transfers with an Idempotency-Key · above the approval threshold this waits for an operator · COMPLETED on Solana finality</div></div>'+
   '<div style="display:flex;gap:10px;margin-top:8px"><button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="closeModal();toast(\\'Settlement created — tr_… · stage APPROVED\\')">Create settlement</button></div>');""", marker="Counterparty (ACTIVE only)")
# Counterparties screen in registration/approval terms
rep("""   pageHead('Contacts','Verified counterparties you can settle with on the network.','<button class="btn btn-primary btn-sm" onclick="toast(\\'Add counterparty opened\\')">+ Add Counterparty</button>')+""",
"""   pageHead('Counterparties','Receiving addresses you may settle to. Register one with POST /v1/counterparties; in sandbox it is ACTIVE at once, in production an operator approves it after the address is whitelisted at the custodian. Disabling is yours; re-enabling is an operator approval.','<button class="btn btn-primary btn-sm" onclick="toast(\\'Add counterparty opened\\')">+ Register counterparty</button>')+""", marker="Receiving addresses you may settle to")
rep("""  var contacts=[
    ['Access Bank','Nigeria','ACC_NG_0021','Verified','bank'],
    ['Equity Bank','Kenya','EQT_KE_0088','Verified','bank'],
    ['RemitPro Ltd','United Kingdom','RMT_UK_0043','Verified','psp'],
    ['PayTech Solutions','Ghana','PTS_GH_0112','Verified','fintech'],
    ['Standard Chartered','United Kingdom','SCB_UK_0007','Verified','bank'],
    ['FinServe Africa','South Africa','FSA_ZA_0055','Pending','psp']
  ];""",
"""  var contacts=[
    ['Partner Bank','solana-mainnet','7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU','ACTIVE','custody whitelisted'],
    ['Hormuud Exchange','solana-mainnet','4hRtB2mJ7yTqQ1dP9zXvL6cN8eK3aF5gH2jM4nP7sLp2','ACTIVE','custody whitelisted'],
    ['RemitPro Ltd','solana-mainnet','9Qw1aB3cD5eF7gH9jK2mN4pR6sT8vW1xY3zA5bC7dZx8','ACTIVE','custody whitelisted'],
    ['PayTech Solutions','solana-mainnet','2bC4dE6fG8hJ1kL3mN5pQ7rS9tU2vW4xY6zA8bD1eFg3','PENDING_APPROVAL','awaiting operator'],
    ['FinServe Africa','solana-mainnet','5fG7hJ9kL2mN4pQ6rS8tU1vW3xY5zA7bC9dE2fH4jKm6','DISABLED','disabled by you']
  ];""", marker="['Partner Bank','solana-mainnet'")
rep("""<td style="color:var(--ink-2)">'+c[1]+'</td><td class="mono" style="font-size:11px;color:var(--teal)">'+c[2]+'</td><td style="text-transform:capitalize;color:var(--ink-2)">'+c[4]+'</td><td><span class="badge badge-'+(c[3]==='Verified'?'completed':'pending')+'">'+c[3]+'</span></td><td><button class="btn btn-primary btn-sm" onclick="toast(\\'Payment initiated\\')">Pay</button></td></tr>';}).join('');""",
"""<td style="color:var(--ink-2)">'+c[1]+'</td><td class="mono" style="font-size:11px;color:var(--teal)">'+c[2].slice(0,6)+'…'+c[2].slice(-6)+'</td><td style="color:var(--ink-2)">'+c[4]+'</td><td><span class="badge badge-'+(c[3]==='ACTIVE'?'completed':c[3]==='DISABLED'?'failed':'pending')+'">'+c[3]+'</span></td><td>'+(c[3]==='ACTIVE'?'<button class="btn btn-primary btn-sm" onclick="openNewPayment()">Settle</button>':'')+'</td></tr>';}).join('');""", marker="c[2].slice(0,6)")
rep("""   kpiCard('&#9737;','Counterparties','6','verified network','flat',6)+
   kpiCard('&#127974;','Banks','3','direct settlement','flat',7,'#34d399')+
   kpiCard('&#9673;','Countries','5','corridors active','flat',5,'#38bdf8')+
   kpiCard('&#9878;','Verified','5 of 6','1 pending KYB','flat',8,'#a78bfa')+'</div>'+
   '<div class="chart-card reveal d1"><div class="ch"><h4>Verified Counterparties</h4></div><div style="overflow-x:auto"><table><thead><tr><th>Counterparty</th><th>Country</th><th>Reference</th><th>Type</th><th>Status</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div><div style="font-size:12px;color:var(--ink-3);margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">Settlement occurs only between verified counterparties holding a network Identity Passport.</div></div>'""",
"""   kpiCard('&#9737;','Counterparties','5','registered','flat',6)+
   kpiCard('&#10003;','ACTIVE','3','can receive','flat',7,'#34d399')+
   kpiCard('&#9202;','Pending approval','1','operator queue','flat',5,'#fbbf24')+
   kpiCard('&#9878;','Custody whitelisted','3 of 3','attested by operations','flat',8,'#a78bfa')+'</div>'+
   '<div class="chart-card reveal d1"><div class="ch"><h4>Counterparties — GET /v1/counterparties</h4></div><div style="overflow-x:auto"><table><thead><tr><th>Label</th><th>Network</th><th>Address</th><th>Approval</th><th>Status</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div><div style="font-size:12px;color:var(--ink-3);margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">An address that is one of AxLink\\'s own custody wallets is refused here — settle to it with a deposit instruction on that institution instead.</div></div>'""", marker="GET /v1/counterparties")
# Approvals queue mirrors the operator endpoints
rep("""  var pending=[
    ['APR_7781','Payment · NGN','Wema Bank → Access Bank','$180,000.00','Michael Osei','Awaiting 2nd approval'],
    ['APR_7782','Counterparty wallet','Hormuud Exchange · Solana address','$—','Michael Osei','Awaiting approval'],
    ['APR_7783','Payment · KES','Equity Bank → KCB','$92,500.00','Sarah Chen','Awaiting approval'],
    ['APR_7784','Settlement above threshold','USDC → Hormuud wallet','$750,000.00','Michael Osei','Awaiting 2nd approval']
  ];""",
"""  var pending=[
    ['tr_9e90d','Transfer · USDC_SOL','galaxy-bank-so · PRODUCTION → Partner Bank 7xKX…9mQw','750,000.000000','policy: available 21.9M, limit 1M, approval: operator','AWAITING_APPROVAL'],
    ['cp_4b11c','Counterparty','galaxy-bank-so · PRODUCTION · PayTech Solutions 2bC4…eFg3','—','attest custody whitelisting before approving','PENDING_APPROVAL']
  ];""", marker="['tr_9e90d','Transfer · USDC_SOL'")
rep("""   pageHead('Approvals','Maker-checker queue — payments and treasury actions awaiting authorization.','<span class="chip"><span class="d" style="background:var(--amber)"></span>4 pending</span>')+""",
"""   pageHead('Approvals','Operator queue: GET /api/settlement/transfers/pending and /counterparties/pending. In production every outbound transfer waits here; in sandbox only those above the auto-approve limit. Approving a transfer writes the journal entry; nothing leaves custody before that.','<span class="chip"><span class="d" style="background:var(--amber)"></span>2 pending</span>')+""", marker="Operator queue: GET /api/settlement/transfers/pending")
rep("""   kpiCard('&#9202;','Pending Approval','4','requires action','flat',6,'#fbbf24')+
   kpiCard('&#10003;','Approved Today','12','$8.4M authorized','up',7,'#34d399')+
   kpiCard('&#128065;','2-Eyes Required','$250K','approval threshold','flat',5,'#38bdf8')+
   kpiCard('&#9919;','Maker-Checker','Enabled','2 approvers min','flat',8,'#a78bfa')+'</div>'+""",
"""   kpiCard('&#9202;','Pending approval','2','requires action','flat',6,'#fbbf24')+
   kpiCard('&#10003;','Approved today','12','journaled, then custody','up',7,'#34d399')+
   kpiCard('&#128065;','Sandbox auto-approve','≤ 100,000','TRANSFER_AUTO_APPROVE_LIMIT_SANDBOX','flat',5,'#38bdf8')+
   kpiCard('&#9919;','Production outbound','Disabled','OUTBOUND_SETTLEMENT_ENABLED unset','flat',8,'#a78bfa')+'</div>'+""", marker="Sandbox auto-approve")
rep("""<span class="chip">1 · Operator creates</span><span style="color:var(--teal)">&#8594;</span><span class="chip">2 · Approver reviews</span><span style="color:var(--teal)">&#8594;</span><span class="chip">3 · 2nd approval if &gt; threshold</span><span style="color:var(--teal)">&#8594;</span><span class="chip">4 · Executed &amp; settled</span>""",
"""<span class="chip">1 · Institution creates (API)</span><span style="color:var(--teal)">&#8594;</span><span class="chip">2 · Policy: balance, limit, counterparty ACTIVE</span><span style="color:var(--teal)">&#8594;</span><span class="chip">3 · Operator approves → journal entry</span><span style="color:var(--teal)">&#8594;</span><span class="chip">4 · Custody → chain → SETTLED on finality</span>""")
open('index.html', 'w', encoding='utf-8').write(src)
print('slice 5 applied')

# ── Slice 6a: portal connected — live layer (tools/live_portal.js inlined) + hooks into the screens ──
src = open('index.html', encoding='utf-8').read()
live = open('tools/live_portal.js', encoding='utf-8').read()
LIVE_START = '<script>/* ===== LIVE PORTAL (Step 2, slice 6a) ====='
if LIVE_START in src:
    # refresh the inlined copy so live_portal.js stays the single source
    a = src.index(LIVE_START); b = src.index('</script>', a) + len('</script>')
    src = src[:a] + '<script>' + live + '</script>' + src[b:]
else:
    rep("""render();
</script>
</body>""", """render();
</script>
<script>""" + live + """</script>
</body>""")
# hooks: live screens take over when a key is connected (ROLE client)
for fn, live_fn in [('appOverview', 'liveOverview'), ('appTreasury', 'liveWallet'), ('appWebhooks', 'liveWebhooks'), ('appDevelopers', 'liveDevelopers'), ('appPayments', 'liveSettlements'), ('appContacts', 'liveCounterparties')]:
    rep('function ' + fn + '(){\n', 'function ' + fn + '(){\n  if(LIVE.me&&ROLE===\'client\') return ' + live_fn + '();\n')
rep("""function toggleEnv(){ ENV=(ENV==='SANDBOX')?'PRODUCTION':'SANDBOX';""", """function toggleEnv(){ if(LIVE.me){ toast('Environment is bound to your API key ('+ENV.toLowerCase()+')'); return; } ENV=(ENV==='SANDBOX')?'PRODUCTION':'SANDBOX';""")
rep("""function signOut(){ var wasOp=(ROLE==='operator'); toast('Signed out');""", """function signOut(){ var wasOp=(ROLE==='operator'); disconnectLive(); toast('Signed out');""")
# banner only while illustrative
rep("""'<main class="content"><div style="background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:8px 14px;font-size:11.5px;color:var(--ink-3);margin-bottom:16px;display:flex;align-items:center;gap:8px">&#9432; Demonstration — figures are illustrative sample data. Live data arrives when this portal is connected to the AxLink API.</div>'+content+'</main></div></div>';""",
"""'<main class="content">'+(LIVE.me?'':'<div style="background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:8px 14px;font-size:11.5px;color:var(--ink-3);margin-bottom:16px;display:flex;align-items:center;gap:8px">&#9432; Demonstration — figures are illustrative sample data. Sign in with your institution API key to see live data.</div>')+content+'</main></div></div>';""", marker="Sign in with your institution API key")
# sign-in: API key is the real credential today
rep("""   '<button class="btn btn-primary" style="width:100%;justify-content:center" onclick="loginAsClient()">Sign In</button>'+""",
"""   '<button class="btn btn-ghost" style="width:100%;justify-content:center" onclick="loginAsClient()">Explore the demo</button>'+
   '<div style="margin:18px 0 10px;padding-top:14px;border-top:1px solid var(--line);font-size:12.5px;color:var(--ink-2)"><b>Connect with your API key</b><div style="font-size:11.5px;color:var(--ink-3);margin-top:4px">Sandbox or production key issued by AxLink operations (axlk_test_… / axlk_live_…). Kept in this tab only.</div></div>'+
   '<div class="field"><label>API key</label><input id="ax-key" type="password" placeholder="axlk_test_…" autocomplete="off"/></div>'+
   (axBase()?'':'<div class="field"><label>API base URL</label><input id="ax-base" placeholder="https://sandbox.api.axlink.network/api/v1"/></div>')+
   '<button class="btn btn-primary" style="width:100%;justify-content:center" onclick="return connectWithKey(document.getElementById(\\'ax-key\\').value,(document.getElementById(\\'ax-base\\')||{}).value)">Connect</button>'+""", marker='id="ax-key"')
# toast renders its message as text, never HTML: API error messages reach it
rep("""  el.innerHTML='<span style="color:var(--teal)">'+(ic||'✓')+'</span><span>'+msg+'</span>';""",
"""  el.innerHTML='<span style="color:var(--teal)">'+(ic||'✓')+'</span><span></span>'; el.lastChild.textContent=String(msg);""")
open('index.html', 'w', encoding='utf-8').write(src)
print('slice 6a applied')

# ── Slice 6b: operator console — Alerts = exception queue, Approvals, Providers go live with the operator key ──
src = open('index.html', encoding='utf-8').read()
for fn, live_fn in [('appAlerts', 'opsAlerts'), ('appApprovals', 'opsApprovals'), ('appProviders', 'opsProviders')]:
    rep('function ' + fn + '(){\n', 'function ' + fn + '(){\n  if(OPS.on&&ROLE===\'operator\') return ' + live_fn + '();\n')
rep("""AxLink staff? <span style="color:var(--ink-2);cursor:pointer;font-weight:600" onclick="loginAsOperator()">Operator sign-in</span></div>'+""",
"""AxLink staff? <span style="color:var(--ink-2);cursor:pointer;font-weight:600" onclick="document.getElementById(\\'ops-box\\').style.display=\\'\\'">Operator sign-in</span></div>'+
   '<div id="ops-box" style="display:none;margin-top:10px"><div class="field"><label>Operator key</label><input id="ax-ops" type="password" placeholder="OPS_API_KEY" autocomplete="off"/></div><button class="btn btn-ghost" style="width:100%;justify-content:center" onclick="return connectAsOperator(document.getElementById(\\'ax-ops\\').value)">Connect operator console</button><div style="text-align:center;margin-top:8px;font-size:11.5px;color:var(--ink-3);cursor:pointer" onclick="loginAsOperator()">or explore the operator demo</div></div>'+""", marker='id="ops-box"')
rep("""function signOut(){ var wasOp=(ROLE==='operator'); disconnectLive(); toast('Signed out');""", """function signOut(){ var wasOp=(ROLE==='operator'); disconnectLive(); disconnectOps(); toast('Signed out');""", marker="disconnectOps(); toast('Signed out')")
rep("""'<main class="content">'+(LIVE.me?'':""", """'<main class="content">'+((LIVE.me||OPS.on)?'':""", marker="(LIVE.me||OPS.on)")
open('index.html', 'w', encoding='utf-8').write(src)
print('slice 6b applied')
