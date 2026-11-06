#!/usr/bin/env python3
"""Step 2 front-end alignment — re-runnable, explicit replacements, fails loudly on a missing anchor.
Run from apps/web:  python3 tools/align_step2.py
Each slice of Step 2 appends its own block here so the site always mirrors what the API does."""
import sys
src = open('index.html', encoding='utf-8').read()

def rep(old, new, count=1):
    global src
    if old not in src:
        if new in src: return  # already applied
        sys.exit(f'anchor missing: {old[:80]!r}')
    src = src.replace(old, new, count)

# ── Slice 1: wallets are live ───────────────────────────────────────────────
rep("""    ['GET','/custody/wallet','Vault balance, available, held','planned'],
    ['GET','/custody/deposit-address','Deposit address per asset (USDC, USDT) for this environment','planned'],""",
"""    ['GET','/wallets','Your wallets in this environment: custody vault, deposit address, balance per asset','live'],
    ['GET','/wallets/{id}/balances','Exact balances per asset (USDC_SOL, USDT_SOL) as decimal strings, from the journal','live'],""")

# Quick-start block gains the live wallet shape
rep("""  var errs="{ \\"error\\": { \\"code\\": \\"UNAUTHORIZED\\", \\"message\\": \\"Invalid or missing API key\\", \\"requestId\\": \\"b849…\\" } }";""",
"""  var walletShape="GET "+base+"/wallets\\nAuthorization: Bearer axlk_"+(ENV==='PRODUCTION'?'live':'test')+"_3d44…   (scope wallets:read)\\n\\n200 OK\\n[{\\n  \\"id\\": \\"wal_…\\", \\"label\\": \\"Treasury\\", \\"status\\": \\"ACTIVE\\", \\"network\\": \\"solana-mainnet\\",\\n  \\"custody\\": { \\"provider\\": \\"fireblocks\\", \\"vaultId\\": \\"…\\" },\\n  \\"depositAddress\\": \\"…\\",            // one address, USDC and USDT\\n  \\"balances\\": [\\n    { \\"asset\\": \\"USDC_SOL\\", \\"available\\": \\"100.123456\\", \\"pending\\": \\"0\\" },\\n    { \\"asset\\": \\"USDT_SOL\\", \\"available\\": \\"0\\", \\"pending\\": \\"0\\" }\\n  ]\\n}]";
  var errs="{ \\"error\\": { \\"code\\": \\"UNAUTHORIZED\\", \\"message\\": \\"Invalid or missing API key\\", \\"requestId\\": \\"b849…\\" } }";""")

rep("""   '<div class="chart-card"><h4 style="margin-bottom:14px">Endpoints</h4><div style="display:flex;flex-direction:column;gap:8px;font-size:12.5px">'+ep+'</div></div></div>'+""",
"""   '<div class="chart-card"><h4 style="margin-bottom:14px">Endpoints</h4><div style="display:flex;flex-direction:column;gap:8px;font-size:12.5px">'+ep+'</div></div></div>'+
   '<div class="chart-card reveal d1" style="margin-bottom:14px"><h4 style="margin-bottom:6px">Wallets — live</h4><div style="font-size:12px;color:var(--ink-3);margin-bottom:12px">A wallet is your custody vault in this environment. Balances are read from the double-entry journal, never from a cache; amounts are exact decimal strings, assets are identified by network and token contract (USDC_SOL, USDT_SOL), never by ticker alone.</div><pre style="background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:14px;font-size:11.5px;line-height:1.55;overflow-x:auto;color:var(--ink)">'+walletShape+'</pre></div>'+""")

# Wallet page: per-asset balances in the API's own terms, beside the deposit address
rep("""<div style="font-size:11px;color:var(--ink-3);margin-top:10px">Environment: '+ENV.toLowerCase()+'. Sandbox addresses hold test USDC/USDT only.</div></div>')+'</div>'+""",
"""<div style="font-size:11px;color:var(--ink-3);margin-top:10px">Environment: '+ENV.toLowerCase()+'. Sandbox addresses hold test USDC/USDT only.</div>'+
        '<h4 style="margin:16px 0 8px">Balances by asset <span style="color:var(--ink-3);font-weight:400;font-size:11px">GET /wallets/{id}/balances</span></h4><table style="font-size:12px"><thead><tr><th>Asset</th><th>Available</th><th>Pending</th></tr></thead><tbody>'+
        n.assets.map(function(a){return '<tr><td class="mono" style="color:var(--teal)">'+a.asset+'</td><td class="mono">'+a.available+'</td><td class="mono" style="color:var(--ink-3)">'+a.pending+'</td></tr>';}).join('')+
        '</tbody></table><div style="font-size:11px;color:var(--ink-3);margin-top:8px">Exact decimal strings from the journal; the USD figures above are these at 1.00.</div></div>')+'</div>'+""")

rep("""DATA.custody = {
  balance: 48250000, available: 41800000, locked: 6450000,""",
"""DATA.custody = {
  balance: 48250000, available: 41800000, locked: 6450000,
  // Shape of GET /wallets/{id}/balances — illustrative values
  assets:[{asset:'USDC_SOL',available:'21900000.000000',pending:'3200000.000000'},{asset:'USDT_SOL',available:'19900000.000000',pending:'3250000.000000'}],""")

open('index.html', 'w', encoding='utf-8').write(src)
print('step-2 alignment applied')
