#!/usr/bin/env python3
"""Align the AxLink front end to the crypto-settlement backend (Step 1 foundation + planned modules).
Explicit, reviewable replacements. Fails loudly if any anchor is missing."""
import re, sys
src = open('axlink-site.html', encoding='utf-8').read()
orig = src
def rep(old, new, count=1):
    global src
    n = src.count(old)
    if n == 0: sys.exit(f'ANCHOR MISSING: {old[:90]!r}')
    if count and n != count: sys.exit(f'ANCHOR COUNT {n} != {count}: {old[:90]!r}')
    src = src.replace(old, new)

# ── Positioning: NDD → public stablecoin settlement ───────────────────────────
rep("a regulated NDD settlement provider connecting institutions through modern, real-time",
    "a regulated crypto settlement network connecting institutions through real-time, on-chain")
rep("['&#9679;','1:1 Reserved','Every unit of NDD is backed 1:1 by cash and short-term U.S. Treasuries. Reserves publis",
    "['&#9679;','Fully Reserved','Every balance is a public stablecoin (USDC) held in regulated custody. Nothing is minted, nothing is lent. Positions publis")
rep("['How is NDD backed?','NDD is backed 1:1 by cash and short-term U.S. Treasury inst",
    "['What is the settlement asset?','USDC on Solana, held in regulated custody (Fireblocks). AxLink never issues a token: it moves existing public stablecoins between institution vaults, and every settlement is proven final on-chain. Reserves are inst")
rep("settling in real time over the AxLink NDD rail.", "settling in real time over the AxLink stablecoin rail.", count=0)
rep("settled over the AxLink NDD rail.", "settled over the AxLink stablecoin rail.")
rep("settling in real time over the AxLink programmable NDD rail.", "settling in real time over the AxLink stablecoin rail.")
rep('font-size="17" fill="var(--ink)" font-family="system-ui">NDD</text>', 'font-size="17" fill="var(--ink)" font-family="system-ui">USDC</text>')
rep('font-size="15" fill="var(--ink)" font-family="system-ui">NDD</text>', 'font-size="15" fill="var(--ink)" font-family="system-ui">USDC</text>')
rep("NDD Settlement,<br><span class=\"gt\">built for the future.</span>", "Stablecoin settlement,<br><span class=\"gt\">proven on-chain.</span>")
rep("AxLink leverages the Digital Dollar (NDD) infrastructure to provide real-time settlement, global reach and unm",
    "AxLink settles on public stablecoins (USDC on Solana) held in regulated custody — real-time settlement, global reach and unm")
rep("['AxLink NDD','USD rail','Provides programmable USD settlement between the institu",
    "['AxLink Rail','Stablecoin','Settles between the institutions on-chain in USDC, proven final before anyone is paid. Routes the institu")
rep("AxLink · NDD Settlement Provider - Regulated · fully reserved · 1:1 backed", "AxLink · Crypto Settlement Network — regulated · fully reserved · nothing minted")
rep("rail:'NDD'", "rail:'USDC'", count=0)
rep("p.rail==='NDD'", "p.rail==='USDC'")
rep("Send instant payments to verified counterparties over the NDD rail.", "Send instant settlements to verified counterparties over the stablecoin rail.")
rep("including fully-reserved digital-dollar (NDD) settlement.", "including on-chain stablecoin settlement.")
rep("At the settlement layer, <b style=\"color:var(--ink)\">NDD — Narrow Digital Dollar</b> provides a digital settlement mechanism designed for continuous, programmable movement of value.",
    "At the settlement layer, <b style=\"color:var(--ink)\">public stablecoins in regulated custody</b> provide continuous, programmable movement of value — proven final on-chain, never minted by AxLink.")
rep("SWIFT &#8594; AxLink &#8594; NDD", "SWIFT &#8594; AxLink &#8594; On-chain settlement")
rep('<span style="font-size:13px;font-weight:700;color:var(--ink-2)">NDD</span></th></tr>', '<span style="font-size:13px;font-weight:700;color:var(--ink-2)">ON-CHAIN</span></th></tr>')
rep("['Institution','AxLink','Payment / FX / Liquidity','NDD','Settlement'].map(function(s,i,arr){var mid=(s==='AxLink'||s==='NDD');",
    "['Institution','AxLink','Custody / FX / Liquidity','USDC','Settlement'].map(function(s,i,arr){var mid=(s==='AxLink'||s==='USDC');")
rep("/* POWERED BY NDD */", "/* POWERED BY PUBLIC STABLECOINS */")
rep("<span class=\"eyebrow\">Powered by NDD</span><h2 style=\"font-size:34px;margin:14px 0 16px\">NDD — Narrow Digital Dollar.</h2><p class=\"lead\">NDD provides a digital settlement layer within the AxLink infrastructure — designed for continuous, programmable movement of institutional value.</p>",
    "<span class=\"eyebrow\">Powered by public stablecoins</span><h2 style=\"font-size:34px;margin:14px 0 16px\">USDC in regulated custody.</h2><p class=\"lead\">AxLink does not issue a token. Institutions hold USDC in segregated custody vaults; settlement between them is one on-chain transfer, proven final before any fiat is released.</p>")
rep("regulated entities and NDD settlement layer, combining institutional regulatory standing with a modern, fully-reserved digital settlement rail.",
    "regulated entities and crypto settlement layer, combining institutional regulatory standing with a modern, fully-reserved on-chain settlement rail.")
rep("var nddList=['24/7 settlement','Near-real-time movement of value','Programmable settlement','Transparent transaction flows','Cross-border settlement','Multi-currency environments','Institutional controls & compliance'];",
    "var nddList=['24/7 settlement','Finality proven on-chain, not assumed','Segregated custody vault per institution','Whitelisted counterparties only','Cross-border settlement in seconds','Local fiat payout where the receiver cannot hold the asset','Institutional controls & compliance'];")

# ── Dashboard nav and environment ─────────────────────────────────────────────
rep("['Settlement','#/app/settlement','◭'],['NDD Reserve','#/app/treasury','◆'],['Liquidity','#/app/liquidity','◍'],",
    "['Settlement','#/app/settlement','◭'],['Treasury','#/app/treasury','◆'],['Liquidity','#/app/liquidity','◍'],['Approvals','#/app/approvals','◈'],['Providers','#/app/providers','⟐'],")
rep("['Overview','#/app','▦'],['Funds','#/app/treasury','◆'],['Payments','#/app/payments','▭'],",
    "['Overview','#/app','▦'],['Wallet','#/app/treasury','◆'],['Settlements','#/app/payments','▭'],['Counterparties','#/app/contacts','▤'],['Webhooks','#/app/webhooks','⇉'],")
rep("['Approvals','#/app/approvals','◈'],['Transactions','#/app/transactions','⇄'],['Contacts','#/app/contacts','▤'],",
    "['Approvals','#/app/approvals','◈'],['Transactions','#/app/transactions','⇄'],")
rep(": {av:'GP',name:'GlobalPay Ltd.',role:'Institution Admin',scope:'GlobalPay Ltd. · SUB_GP01'};",
    ": {av:'GB',name:'Galaxy Bank',role:'Institution Admin',scope:'Galaxy Bank · galaxy-bank-so'};")
rep("<span style=\"width:7px;height:7px;border-radius:50%;background:var(--green)\"></span>Production</span><span>▾</span></div></div></aside>",
    "<span style=\"width:7px;height:7px;border-radius:50%;background:'+(ENV==='PRODUCTION'?'var(--green)':'#fbbf24')+'\"></span>'+(ENV==='PRODUCTION'?'Production':'Sandbox')+'</span><button onclick=\"toggleEnv()\" style=\"font-size:11px;color:var(--ink-3)\">switch ▾</button></div></div></aside>")
rep("var ROLE = 'client';", "var ROLE = 'client';\nvar ENV = 'SANDBOX'; /* every institution starts in sandbox; production is enabled by AxLink after go-live */\nfunction toggleEnv(){ ENV=(ENV==='SANDBOX')?'PRODUCTION':'SANDBOX'; toast('Switched to '+ENV.toLowerCase()+' environment'); render(); }")
rep("Demonstration environment — figures shown are illustrative sample data, not live production values.",
    "Demonstration — figures are illustrative sample data. Live data arrives when this portal is connected to the AxLink API.")

# ── Data fixtures ─────────────────────────────────────────────────────────────
rep("""  reserves:[
    {name:'Cash (demand deposits)',pct:38,color:'#2ee6c5',amt:'$18.3M'},
    {name:'Short-term U.S. Treasuries',pct:54,color:'#22c7d4',amt:'$26.1M'},
    {name:'Overnight Treasury repo',pct:8,color:'#38bdf8',amt:'$3.9M'}
  ],""", """  reserves:[
    {name:'USDC · treasury reserve vault',pct:62,color:'#2ee6c5',amt:'$29.9M'},
    {name:'USDC · institution vault floats',pct:30,color:'#22c7d4',amt:'$14.5M'},
    {name:'In transit (liquidity fills)',pct:8,color:'#38bdf8',amt:'$3.9M'}
  ],""")
rep("""    {id:'MINT_7F21',type:'Mint',amount:5000000,from:'Wire · JPMorgan ****8842',status:'Completed',at:'May 16, 09:14',hash:'0x8f7a…1cC8'},
    {id:'RDMP_9C03',type:'Redeem',amount:2500000,from:'NDD → USD · Choice Bank',status:'Completed',at:'May 15, 16:40',hash:'0x1cc8…d76F'},
    {id:'MINT_4A88',type:'Mint',amount:10000000,from:'Wire · Standard Chartered',status:'Processing',at:'May 15, 11:02',hash:'—'},
    {id:'MINT_2B19',type:'Mint',amount:1250000,from:'Wire · First Capital',status:'Completed',at:'May 14, 14:28',hash:'0x3d44…E5a1'},
    {id:'RDMP_6D52',type:'Redeem',amount:750000,from:'NDD → USD · Breinrock',status:'Completed',at:'May 14, 09:55',hash:'0x7b22…D9f0'}""",
    """    {id:'DEP_7F21',type:'Deposit',amount:5000000,from:'USDC · on-chain deposit to vault',status:'Completed',at:'May 16, 09:14',hash:'5Kj8…1cC8'},
    {id:'WDR_9C03',type:'Withdrawal',amount:2500000,from:'USDC → whitelisted wallet · Hormuud',status:'Completed',at:'May 15, 16:40',hash:'3xQc…d76F'},
    {id:'DEP_4A88',type:'Deposit',amount:10000000,from:'USD wire → USDC via liquidity',status:'Processing',at:'May 15, 11:02',hash:'—'},
    {id:'DEP_2B19',type:'Deposit',amount:1250000,from:'USDC · on-chain deposit to vault',status:'Completed',at:'May 14, 14:28',hash:'9Fd4…E5a1'},
    {id:'WDR_6D52',type:'Withdrawal',amount:750000,from:'USDC → USD payout · Breinrock',status:'Completed',at:'May 14, 09:55',hash:'7bB2…D9f0'}""")
rep("  chains:['Ethereum','Base','Solana','Polygon','Arbitrum','Stellar'],\n  contract:'0x1cC8E2C5E93cA2439a8E4FC6C9cD68381267d76F'",
    "  chains:['Solana (USDC) · live','Ethereum · planned','Base · planned','Polygon · planned'],\n  contract:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'")
rep("""  {name:'Production · Server',prefix:'ax_live_8f72…',created:'Apr 12, 2026',last:'2 min ago',scope:'mint, redeem, read'},
  {name:'Sandbox · Test',prefix:'ax_test_3d44…',created:'Apr 12, 2026',last:'1 hr ago',scope:'full (sandbox)'},
  {name:'Webhooks · Ledger',prefix:'ax_whk_9c11…',created:'Mar 28, 2026',last:'12 min ago',scope:'read, events'}""",
    """  {name:'Sandbox · integration',prefix:'axlk_test_3d44…',created:'Nov 6, 2026',last:'2 min ago',scope:'settlement:*, custody:read'},
  {name:'Sandbox · read-only reporting',prefix:'axlk_test_9c11…',created:'Nov 6, 2026',last:'1 hr ago',scope:'settlement:read'},
  {name:'Production · server',prefix:'axlk_live_— (issued at go-live)',created:'—',last:'—',scope:'disabled until go-live'}""")

# ── Wallet page (was Funds / NDD Reserve) ─────────────────────────────────────
start = src.index("function appTreasury(){"); end = src.index("/* ===== DEVELOPERS / API CONSOLE ===== */")
wallet = r'''function appTreasury(){
  var n=DATA.ndd;
  var moves=n.mints.map(function(m){return '<tr><td class="txid">'+m.id+'</td><td><span class="badge badge-'+(m.type==='Deposit'?'active':'review')+'">'+m.type+'</span></td><td>'+usdFull(m.amount)+'</td><td style="color:var(--ink-2)">'+m.from+'</td><td><span class="badge badge-'+(m.status==='Completed'?'completed':'pending')+'">'+m.status+'</span></td><td class="mono" style="color:var(--ink-3);font-size:11px">'+m.hash+'</td><td style="color:var(--ink-3)">'+m.at+'</td></tr>';}).join('');
  var subs=n.subAccounts.map(function(s){return '<tr><td style="font-weight:500">'+s.name+'</td><td class="mono" style="font-size:11px;color:var(--teal)">'+s.ref+'</td><td>'+s.bal+'</td><td style="color:var(--ink-2)">'+s.mtd+'</td><td><span class="badge badge-'+(s.status==='Active'?'active':'review')+'">'+s.status+'</span></td></tr>';}).join('');
  var chains=n.chains.map(function(c){return '<span class="chip"><span class="d" style="background:'+(c.indexOf('live')>0?'var(--teal)':'var(--ink-3)')+'"></span>'+c+'</span>';}).join(' ');
  var isOp=(ROLE==='operator');
  var depositAddr=(ENV==='PRODUCTION')?'— issued at go-live —':'Gx7k…sandbox-vault-galaxy-bank-so…Q2mP';
  return appShell('#/app/treasury',
   pageHead(isOp?'Treasury':'Wallet',isOp?'Network-wide settlement asset: reserve vault, institution floats, liquidity in transit.':'Your institution\'s custody vault on AxLink. Balances are USDC on Solana; you see them as USD.',isOp?'<button class="btn btn-ghost btn-sm" onclick="toast(\'Reconciliation run started\')">Reconcile now</button><button class="btn btn-primary btn-sm" onclick="toast(\'Rebalance proposed — needs a second approver\')">Propose rebalance</button>':'<button class="btn btn-ghost btn-sm" onclick="openRedeem()">Withdraw</button><button class="btn btn-primary btn-sm" onclick="openMint()">+ Deposit</button>')+
   '<div class="kpi-cards reveal" style="grid-template-columns:repeat(4,1fr)">'+
   kpiCard(isOp?'&#9670;':'$',isOp?'Settlement asset under custody':'Balance',isOp?'$48.3M':usdM(n.balance),isOp?'USDC · Solana':'USDC · shown as USD','flat',6)+
   kpiCard('&#9683;','Available',usdM(n.available),'ready to settle','up',7,'#34d399')+
   kpiCard('&#9638;','Held / in flight',usdM(n.locked),'settling or awaiting approval','flat',4,'#fbbf24')+
   kpiCard('&#9671;',isOp?'Vault = ledger':'Finality',isOp?'matched 5 min ago':'on-chain proof','reconciled','flat',8,'#38bdf8')+'</div>'+
   '<div class="grid-15-1 reveal d1" style="margin-bottom:14px"><div class="chart-card"><div class="ch"><h4>'+(isOp?'Reserve and float movements':'Wallet activity')+'</h4><span class="sel">Last 7 days</span></div>'+lineChart([{color:'#2ee6c5',seed:2},{color:'#a78bfa',seed:4}])+
   '<div style="display:flex;gap:18px;justify-content:center;margin-top:10px;font-size:12px;color:var(--ink-2)"><span style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:50%;background:#2ee6c5"></span>Deposits</span><span style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:50%;background:#a78bfa"></span>Withdrawals</span></div></div>'+
   (isOp?'<div class="chart-card"><h4 style="margin-bottom:14px">Where the asset sits</h4><div class="donut-wrap"><div style="flex:0 0 46%">'+donutSVG(n.reserves,['100%','Custody'])+'</div><div style="flex:1"><div class="legend">'+n.reserves.map(function(r){return '<div class="row"><span class="dot" style="background:'+r.color+'"></span><span class="nm">'+r.name+'</span><span style="font-weight:500">'+r.pct+'%</span></div>';}).join('')+'</div></div></div><div style="font-size:11px;color:var(--ink-3);margin-top:12px;text-align:center">Every vault is reconciled against the ledger every 5 minutes</div></div>'
        :'<div class="chart-card"><h4 style="margin-bottom:10px">Deposit address</h4><div style="font-size:12.5px;color:var(--ink-2);margin-bottom:8px">USDC on Solana only. Credited after on-chain finality.</div><div class="mono" style="font-size:11.5px;color:var(--teal);word-break:break-all;background:var(--panel-2);padding:10px;border-radius:8px;cursor:pointer" onclick="toast(\'Deposit address copied\')">'+depositAddr+'</div><div style="font-size:11px;color:var(--ink-3);margin-top:10px">Environment: '+ENV.toLowerCase()+'. Sandbox addresses hold test USDC only.</div></div>')+'</div>'+
   '<div class="chart-card reveal d2" style="margin-bottom:14px"><div class="ch"><h4>'+(isOp?'Recent reserve movements':'Recent deposits and withdrawals')+'</h4><a href="javascript:void(0)" onclick="return go(\'#/app/transactions\')" style="color:var(--teal);font-size:13px;font-weight:500">View all</a></div><div style="overflow-x:auto"><table><thead><tr><th>ID</th><th>Type</th><th>Amount</th><th>Source / Destination</th><th>Status</th><th>Tx</th><th>Time</th></tr></thead><tbody>'+moves+'</tbody></table></div></div>'+
   (isOp
     ? '<div class="grid-2 reveal d3" style="gap:14px"><div class="chart-card"><div class="ch"><h4>Institution vaults <span style="color:var(--ink-3);font-weight:400">one per institution per environment</span></h4><button class="btn btn-ghost btn-sm" onclick="toast(\'Vault provisioning opened\')">+ Provision</button></div><div style="overflow-x:auto"><table><thead><tr><th>Institution</th><th>Vault</th><th>Balance</th><th>MTD Volume</th><th>Status</th></tr></thead><tbody>'+subs+'</tbody></table></div></div>'+
       '<div class="chart-card"><h4 style="margin-bottom:14px">Networks</h4><div style="font-size:12.5px;color:var(--ink-2);margin-bottom:10px">Settlement asset and chains:</div><div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">'+chains+'</div>'+
       '<div style="border-top:1px solid var(--line);padding-top:14px"><div style="font-size:12px;color:var(--ink-3);margin-bottom:6px">USDC mint (Solana)</div><div class="mono" style="font-size:11.5px;color:var(--teal);word-break:break-all;background:var(--panel-2);padding:10px;border-radius:8px;cursor:pointer" onclick="toast(\'Mint address copied\')">'+n.contract+'</div></div></div></div>'
     : '<div class="chart-card reveal d3"><div class="ch"><h4>Fiat accounts for payouts</h4><button class="btn btn-ghost btn-sm" onclick="toast(\'Add account opened\')">+ Add Account</button></div><table><thead><tr><th>Account</th><th>Bank</th><th>Currency</th><th>Status</th></tr></thead><tbody><tr><td class="mono" style="font-size:12px">****8842</td><td>Galaxy Bank nostro</td><td>USD</td><td><span class="badge badge-active">Verified</span></td></tr><tr><td class="mono" style="font-size:12px">****3391</td><td>Choice Bank</td><td>KES</td><td><span class="badge badge-active">Verified</span></td></tr></tbody></table><div style="font-size:11px;color:var(--ink-3);margin-top:12px">Used only when a counterparty cannot hold USDC: AxLink pays local fiat from its float and takes the asset back.</div></div>')
  );
}
function openMint(){
  var isOp=(ROLE==='operator');
  if(isOp){
    openModal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px"><h3 style="font-size:19px">Propose treasury rebalance</h3><span style="color:var(--ink-3);cursor:pointer" onclick="closeModal()">x</span></div>'+
     '<p class="lead" style="font-size:13.5px;margin-bottom:20px">Buy USDC with fiat float through a liquidity provider, or sweep between the reserve vault and an institution float. Two different approvers are required.</p>'+
     '<div class="field"><label>Route</label><select><option>BUY_USDC_USD · liquidity provider</option><option>SWEEP · reserve → institution float</option><option>CAPITAL_TRANSFER · fiat float top-up</option></select></div>'+
     '<div class="field"><label>Amount</label><input placeholder="5,000,000" value="5,000,000"/><div class="hint">Within the daily buy cap and in-transit cap set by policy</div></div>'+
     '<div style="display:flex;gap:10px;margin-top:8px"><button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="closeModal();toast(\'Rebalance proposed — awaiting second approver\')">Propose</button></div>');
  }else{
    openModal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px"><h3 style="font-size:19px">Deposit</h3><span style="color:var(--ink-3);cursor:pointer" onclick="closeModal()">x</span></div>'+
     '<p class="lead" style="font-size:13.5px;margin-bottom:20px">Send USDC on Solana to your vault address, or wire fiat and AxLink converts it to USDC through its liquidity providers.</p>'+
     '<div class="field"><label>Method</label><select><option>USDC on-chain → vault deposit address</option><option>USD wire → converted to USDC</option></select></div>'+
     '<div class="field"><label>Amount (USD)</label><input placeholder="5,000,000" value="5,000,000"/><div class="hint">Credited after on-chain finality · no deposit fee</div></div>'+
     '<div style="display:flex;gap:10px;margin-top:8px"><button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="closeModal();toast(\'Deposit expected — $5,000,000\')">Create deposit</button></div>');
  }
}
function openRedeem(){
  var isOp=(ROLE==='operator');
  if(isOp){
    openModal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px"><h3 style="font-size:19px">Reconciliation</h3><span style="color:var(--ink-3);cursor:pointer" onclick="closeModal()">x</span></div>'+
     '<p class="lead" style="font-size:13.5px;margin-bottom:20px">Custodian balance of every vault compared with the ledger. A mismatch opens a case and freezes payouts from that vault until resolved.</p>'+
     '<div style="display:flex;gap:10px;margin-top:8px"><button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="closeModal()">Close</button><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="closeModal();toast(\'Reconciliation run: all vaults match\')">Run now</button></div>');
  }else{
    openModal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px"><h3 style="font-size:19px">Withdraw</h3><span style="color:var(--ink-3);cursor:pointer" onclick="closeModal()">x</span></div>'+
     '<p class="lead" style="font-size:13.5px;margin-bottom:20px">Send USDC to one of your whitelisted wallets, or pay out fiat to a verified bank account. Amounts above your threshold need a second approver.</p>'+
     '<div class="field"><label>Destination</label><select><option>Whitelisted wallet · Galaxy treasury (Solana)</option><option>Fiat payout · Galaxy Bank nostro ****8842 (USD)</option><option>Fiat payout · Choice Bank ****3391 (KES)</option></select></div>'+
     '<div class="field"><label>Amount (USD)</label><input placeholder="2,500,000" value="2,500,000"/><div class="hint">On-chain: seconds · Fiat payout: domestic rail timing</div></div>'+
     '<div style="display:flex;gap:10px;margin-top:8px"><button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="closeModal();toast(\'Withdrawal submitted — $2,500,000\')">Withdraw</button></div>');
  }
}
'''
src = src[:start] + wallet + src[end:]

# ── Developers page: the real API ─────────────────────────────────────────────
start = src.index("function appDevelopers(){"); end = src.index("DATA.accounts=[")
dev = r'''function appDevelopers(){
  var keys=DATA.apiKeys.map(function(k){return '<tr><td style="font-weight:500">'+k.name+'</td><td class="mono" style="font-size:12px;color:var(--teal)">'+k.prefix+'</td><td style="color:var(--ink-2)">'+k.scope+'</td><td style="color:var(--ink-3)">'+k.created+'</td><td style="color:var(--ink-3)">'+k.last+'</td><td><button class="btn btn-ghost btn-sm" onclick="toast(\'Key revoked\')">Revoke</button></td></tr>';}).join('');
  var base=(ENV==='PRODUCTION')?'https://api.axlink.network/api':'https://sandbox.api.axlink.network/api';
  var code="GET "+base+"/institutions/me\nAuthorization: Bearer axlk_"+(ENV==='PRODUCTION'?'live':'test')+"_3d44…\n\n200 OK\n{\n  \"institution\": { \"id\": \"inst_…\", \"slug\": \"galaxy-bank-so\" },\n  \"environment\": \""+ENV+"\",\n  \"scopes\": [\"settlement:*\", \"custody:read\"]\n}";
  var ep=[
    ['GET','/institutions/me','Identify the calling institution and environment','live'],
    ['GET','/health · /ready','Liveness and readiness','live'],
    ['GET','/custody/wallet','Vault balance, available, held','planned'],
    ['GET','/custody/deposit-address','USDC deposit address for this environment','planned'],
    ['POST','/settlements','Settle to a whitelisted counterparty (USDC) or a fiat beneficiary','planned'],
    ['GET','/settlements/{id}','Status: PROCESSING · COMPLETED · FAILED, with on-chain proof','planned'],
    ['POST','/counterparties','Register a counterparty wallet (screened, then approved)','planned'],
    ['POST','/payouts','Local fiat payout where the receiver cannot hold the asset','planned'],
    ['GET','/liquidity/quote','Indicative USDC ↔ fiat rate, 30 s lock','planned'],
    ['POST','/webhooks/endpoints','Register a signed webhook endpoint','planned']
  ].map(function(e){return '<div style="display:flex;align-items:center;gap:10px"><span class="badge badge-'+(e[0]==='GET'?'review':'active')+'" style="min-width:44px;justify-content:center">'+e[0]+'</span><span class="mono" style="color:var(--ink);font-size:12px">'+e[1]+'</span><span style="color:var(--ink-3);font-size:11.5px;flex:1">'+e[2]+'</span><span class="chip" style="font-size:10px;padding:1px 7px;'+(e[3]==='live'?'background:rgba(46,230,197,.12);color:var(--teal)':'')+'">'+e[3]+'</span></div>';}).join('');
  var sig="X-AxLink-Signature: t=1762400000,v1=<hex HMAC-SHA256(secret, t + \".\" + body)>\nX-AxLink-Event-Id: evt_…    (store it; duplicates are redelivered)\n\n{ \"id\": \"evt_…\", \"type\": \"settlement.completed\", \"data\": { \"settlementId\": \"…\", \"txHash\": \"…\" } }";
  var errs="{ \"error\": { \"code\": \"UNAUTHORIZED\", \"message\": \"Invalid or missing API key\", \"requestId\": \"b849…\" } }";
  return appShell('#/app/developers',
   pageHead('Developers','API keys, environments, endpoints and webhooks. Sandbox and production are fully separate: separate keys, separate vaults, separate webhooks.','<a class="btn btn-ghost btn-sm" href="'+base+'/docs" target="_blank" rel="noopener">OpenAPI</a><button class="btn btn-primary btn-sm" onclick="toast(\'Request a new sandbox key from AxLink operations\')">+ New API Key</button>')+
   '<div class="grid-15-1 reveal" style="margin-bottom:14px"><div class="chart-card"><h4 style="margin-bottom:6px">Quick start — identify yourself</h4><div style="font-size:12px;color:var(--ink-3);margin-bottom:12px">Base URL for '+ENV.toLowerCase()+': <span class="mono" style="color:var(--teal)">'+base+'</span></div><pre style="background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:16px;font-size:12px;line-height:1.6;overflow-x:auto;color:var(--ink-2);white-space:pre-wrap" class="mono">'+code+'</pre></div>'+
   '<div class="chart-card"><h4 style="margin-bottom:14px">Endpoints</h4><div style="display:flex;flex-direction:column;gap:8px;font-size:12.5px">'+ep+'</div></div></div>'+
   '<div class="chart-card reveal d1" style="margin-bottom:14px"><h4 style="margin-bottom:14px">API keys · '+ENV.toLowerCase()+'</h4><div style="overflow-x:auto"><table><thead><tr><th>Name</th><th>Key prefix</th><th>Scopes</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>'+keys+'</tbody></table></div><div style="font-size:11px;color:var(--ink-3);margin-top:10px">Keys are shown once at issue. A key carries one environment and a scope list; there is no key that works in both environments.</div></div>'+
   '<div class="grid-2 reveal d2" style="gap:14px;margin-bottom:14px"><div class="chart-card"><h4 style="margin-bottom:10px">Signed webhooks</h4><pre style="background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:14px;font-size:11.5px;line-height:1.6;overflow-x:auto;color:var(--ink-2);white-space:pre-wrap" class="mono">'+sig+'</pre><div style="font-size:11.5px;color:var(--ink-3);margin-top:8px">Verify with your endpoint secret; reject if |now − t| &gt; 5 minutes. Retries: 1m · 5m · 30m · 2h · 12h, then dead-lettered and replayable by AxLink operations.</div></div>'+
   '<div class="chart-card"><h4 style="margin-bottom:10px">Errors</h4><pre style="background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:14px;font-size:11.5px;line-height:1.6;overflow-x:auto;color:var(--ink-2);white-space:pre-wrap" class="mono">'+errs+'</pre><div style="font-size:11.5px;color:var(--ink-3);margin-top:8px">Every response carries <span class="mono">X-Request-Id</span>; quote it when contacting support. Settlements expose three statuses only: PROCESSING, COMPLETED, FAILED.</div></div></div>'+
   '<div class="grid-3 reveal d3">'+
   ['Idempotent|Send Idempotency-Key on every POST. The same key with the same body replays the first response; a different body is refused.','Finality, proven|A settlement is COMPLETED only when the chain reports the transfer final — never when a custodian returns an id.','Whitelisted only|USDC leaves a vault only to an address that has been screened and approved. Everything else is refused.'].map(function(s){var p=s.split('|');return '<div class="chart-card"><h4 style="font-size:14px;margin-bottom:6px">'+p[0]+'</h4><p style="font-size:12.5px;color:var(--ink-3);line-height:1.5">'+p[1]+'</p></div>';}).join('')+'</div>'
  );
}
'''
src = src[:start] + dev + src[end:]

# ── New routes: Webhooks (institution) and Providers (operator) ───────────────
rep("'#/app/alerts':appAlerts,", "'#/app/alerts':appAlerts,'#/app/webhooks':appWebhooks,'#/app/providers':appProviders,")
newpages = r'''
/* ===== WEBHOOKS (institution) ===== */
function appWebhooks(){
  var rows=[['evt_8f21','settlement.completed','200','2 min ago','Delivered'],['evt_8f1c','settlement.processing','200','2 min ago','Delivered'],['evt_8e90','deposit.credited','503 → retry in 5m','14 min ago','Pending'],['evt_8d77','counterparty.approved','200','1 hr ago','Delivered']].map(function(r){return '<tr><td class="txid">'+r[0]+'</td><td class="mono" style="font-size:12px">'+r[1]+'</td><td style="color:var(--ink-2)">'+r[2]+'</td><td style="color:var(--ink-3)">'+r[3]+'</td><td><span class="badge badge-'+(r[4]==='Delivered'?'completed':'pending')+'">'+r[4]+'</span></td><td><button class="btn btn-ghost btn-sm" onclick="toast(\'Replay queued\')">Replay</button></td></tr>';}).join('');
  return appShell('#/app/webhooks',
   pageHead('Webhooks','Signed event deliveries to your endpoint for this environment ('+ENV.toLowerCase()+').','<button class="btn btn-primary btn-sm" onclick="toast(\'Endpoint saved — secret shown once\')">+ Add endpoint</button>')+
   '<div class="chart-card reveal" style="margin-bottom:14px"><h4 style="margin-bottom:10px">Endpoint</h4><div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center"><div class="mono" style="font-size:12.5px;color:var(--teal)">https://api.galaxybank.so/axlink/events</div><span class="badge badge-active">Active</span></div><div style="font-size:11.5px;color:var(--ink-3);margin-top:8px">Events: settlement.* · deposit.* · counterparty.* · payout.*. Signature header <span class="mono">X-AxLink-Signature</span>; secret rotatable from here.</div></div>'+
   '<div class="chart-card reveal d1"><div class="ch"><h4>Recent deliveries</h4></div><div style="overflow-x:auto"><table><thead><tr><th>Event</th><th>Type</th><th>Response</th><th>When</th><th>Status</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div></div>'
  );
}
/* ===== PROVIDERS (operator) ===== */
function appProviders(){
  if(ROLE!=='operator') return operatorOnly('#/app/providers','Providers');
  var rows=[['Custody','Fireblocks · AxLink workspace','custody.primary','vault-treasury, 5 institution vaults','Healthy'],['Blockchain','Solana RPC (dedicated node)','chain.solana','finality proof, balances','Healthy'],['Liquidity','B2BinPay','lp.usd.primary','USDC ↔ USD / EUR / GBP','Healthy'],['Fiat payout · KES','Choice Bank','door.ke.primary','M-Pesa B2C · PesaLink · RTGS','Healthy'],['Fiat payout · USD','Brainrock','door.us.primary','ACH · wire','Degraded'],['Screening','— (sandbox stub)','screening.primary','names, addresses','Sandbox']].map(function(r){return '<tr><td style="font-weight:500">'+r[0]+'</td><td>'+r[1]+'</td><td class="mono" style="font-size:11.5px;color:var(--teal)">'+r[2]+'</td><td style="color:var(--ink-2)">'+r[3]+'</td><td><span class="badge badge-'+(r[4]==='Healthy'?'completed':r[4]==='Degraded'?'pending':'review')+'">'+r[4]+'</span></td></tr>';}).join('');
  return appShell('#/app/providers',
   pageHead('Providers','Every provider is an adapter behind a port. The core names none of them; swapping one is one adapter and one config row.')+
   '<div class="chart-card reveal"><div style="overflow-x:auto"><table><thead><tr><th>Role</th><th>Provider</th><th>Adapter id</th><th>Used for</th><th>Health</th></tr></thead><tbody>'+rows+'</tbody></table></div><div style="font-size:11.5px;color:var(--ink-3);margin-top:10px">Ports: CustodyProvider · LiquidityProvider · BlockchainProvider · CrossChainProvider · FiatPayoutProvider. An unhealthy adapter is skipped by routing and never retried inside a settlement.</div></div>'
  );
}
'''
src = src.replace("/* ===== DEVELOPERS / API CONSOLE ===== */", newpages + "/* ===== DEVELOPERS / API CONSOLE ===== */", 1)

# ── Lifecycle / developers public page ────────────────────────────────────────
rep("['▤','Settlement','Value is settled in real-time via the AxLink NDD rail.']", "['▤','Settlement','USDC moves between institution vaults; the chain proves it final.']")
rep("'Real-time USD settlement|AxLink settles the institutional leg instantly in programmable USD - no correspondent chains, no batch windows.'",
    "'Real-time on-chain settlement|AxLink settles the institutional leg in USDC in seconds — no correspondent chains, no batch windows — and releases fiat only after finality.'")


# ── Second pass: remaining NDD mentions ───────────────────────────────────────
rep("/* ===== NDD / TREASURY / ONBOARDING DATA (institutional NDD settlement) ===== */", "/* ===== WALLET / TREASURY / ONBOARDING DATA (institutional stablecoin settlement) ===== */")
rep("['Treasury (NDD)','#/signin']", "['Wallet &amp; custody','#/signin']")
rep("<span>Regulated NDD Settlement - Global Reach</span>", "<span>Regulated Crypto Settlement - Global Reach</span>")
rep("['&#9679;','1:1 reserved settlement','Every unit of NDD is backed 1:1 by cash and short-term instruments, with transparent, publishe",
    "['&#9679;','Fully reserved settlement','Every balance is USDC held in regulated custody; nothing is minted or lent, and every vault is reconciled against the ledger. Positions publishe")
rep("/* NDD settlement center-bottom */", "/* settlement center-bottom */")
rep("Routes the institutions, 1:1 NDD.", "Routes the corridor end to end.")
rep("Wire USD to your dedicated account. Funds are locked 1:1 in a fully-reserved narrow bank and NDD is minted to your balance. We never lend out your deposits.",
    "Send USDC to your vault address, or wire USD and AxLink converts it to USDC through its liquidity providers. Your balance is held in a segregated custody vault; we never lend it out.")
rep("/* ===== NDD TREASURY (Mint / Redeem) ===== */", "/* ===== WALLET / TREASURY ===== */")
rep("'USD EUR GBP NDD'", "'USD EUR GBP USDC'")
rep(">Manage NDD</button>", ">Manage wallet</button>")
rep("'instant on NDD'", "'instant on-chain'")
rep("<option>GBP</option><option>NDD</option></select>", "<option>GBP</option><option>USDC</option></select>")
rep("<option>NDD — instant (recommended)</option><option>SWIFT — 1-3 days</option>", "<option>On-chain USDC — instant (recommended)</option><option>Local fiat payout — domestic rail</option>")
rep("card('&#9673;','NDD Reserve','Issuance &amp; reserve controls','#/app/treasury')", "card('&#9673;','Treasury','Reserve vault, floats &amp; rebalancing','#/app/treasury')")
rep("'Manage your NDD sub-accounts'", "'Manage your sub-ledger accounts'")
rep("['APR_7782','Mint NDD','Wire · Standard Chartered','$5,000,000.00','Michael Osei','Awaiting approv", "['APR_7782','Counterparty wallet','Hormuud Exchange · Solana address','$—','Michael Osei','Awaiting approv")
rep("['APR_7784','Redeem NDD','NDD → USD · Choice Bank','$750,000.00','Michael Osei','Awaiting 2nd approval']", "['APR_7784','Settlement above threshold','USDC → Hormuud wallet','$750,000.00','Michael Osei','Awaiting 2nd approval']")
rep("// NDD convergence node (far right center) - caps converge into it", "// settlement convergence node (far right center) - caps converge into it")
rep('font-family="system-ui">NDD + rails</text>', 'font-family="system-ui">USDC + rails</text>')
rep("// caps -> NDD converging lines", "// caps -> settlement converging lines")
rep("// NDD -> global settlement (markets fan out, bottom)", "// settlement -> global (markets fan out, bottom)")
rep("['&#9670;','Digital settlement (NDD)','Access fully-reserved digital-dollar settlement as one of the available r", "['&#9670;','On-chain settlement (USDC)','Settle in public stablecoins held in regulated custody as one of the available r")
rep("var axl=['Institution','AXLINK','Payment Rails + FX + Liquidity','NDD','Global Settlement'];", "var axl=['Institution','AXLINK','Custody + FX + Liquidity','USDC','Global Settlement'];")
rep("var hot=accent&&(s==='AXLINK'||s==='NDD'||s==='Global Settlement');", "var hot=accent&&(s==='AXLINK'||s==='USDC'||s==='Global Settlement');")
rep("providing the underlying, fully-reserved NDD digital settlement infrastructure through its regulated entities.", "providing the underlying regulated custody and crypto settlement infrastructure through its licensed entities.")
rep("['&#9679;','Fully Reserved','NDD is backed 1:1 by cash and short-term instruments, with transparent reserves ", "['&#9679;','Fully Reserved','Balances are USDC in regulated custody, reconciled against the ledger every five minutes, with transparent positions ")

rep("{id:'ACC_NDD_01',name:'NDD Treasury',type:'Digital',cur:'NDD',bal:'$48,250,000.00',status:'Active',iban:'0x1cC8…d76F'", "{id:'ACC_USDC_01',name:'Custody vault · USDC',type:'Custody',cur:'USDC',bal:'$48,250,000.00',status:'Active',iban:'Gx7k…Q2mP'")
rep("{cur:'NDD',avail:'$41,800,000',hold:'$6,450,000',total:'$48,250,00", "{cur:'USDC',avail:'$41,800,000',hold:'$6,450,000',total:'$48,250,00")
src=src.replace("var NDDMARK=","var SETTLEMARK=").replace("NDDMARK","SETTLEMARK")
assert 'NDD' not in src, [m.start() for m in re.finditer('NDD', src)][:5]
# Not an issuer: AxLink settles existing public stablecoins on a public network. Remove the last
# issuance-era identifiers (internal names only; the visible copy already says nothing is minted).
src=src.replace('openMint(','openFunding(').replace('DATA.ndd','DATA.custody').replace('ndd:{','custody:{').replace('.mints','.movements').replace('mints:[','movements:[')
src=src.replace('capToNdd','capToCustody').replace('var ndd=','var custodyLayer=').replace('+axlink+ndd+phases+','+axlink+custodyLayer+phases+')
assert 'openMint' not in src and 'DATA.ndd' not in src and '.mints' not in src

open('axlink-site.html', 'w', encoding='utf-8').write(src)
print('ok', len(orig), '->', len(src))
