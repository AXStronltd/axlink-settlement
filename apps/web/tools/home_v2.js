function pageHome(){
  /* ── Home v2 (institutional): every figure on this page is verifiable from the code or the sandbox ── */
  function ic(path){return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+path+'</svg>';}
  var I={
    key:ic('<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 20 3M16 7l3 3M14 9l2 2"/>'),
    route:ic('<circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M7.5 6H15a4 4 0 0 1 0 8H9a4 4 0 0 0 0 8h7.5"/>'),
    check:ic('<path d="M9 12l2 2 4-4"/><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>'),
    vault:ic('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="3.5"/><path d="M12 8.5V7M12 17v-1.5M15.5 12H17M7 12h1.5"/>'),
    coin:ic('<circle cx="12" cy="12" r="9"/><path d="M14.8 9.2c-.5-.9-1.6-1.4-2.8-1.4-1.7 0-3 .9-3 2.2 0 3 6 1.6 6 4.4 0 1.3-1.3 2.2-3 2.2-1.3 0-2.4-.6-2.9-1.5M12 6v1.8M12 16.6V18"/>'),
    sign:ic('<path d="M4 4h12l4 4v12H4z"/><path d="M8 13l2.5 2.5L16 10"/>'),
    book:ic('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M8 7h7M8 11h7"/>'),
    code:ic('<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>'),
    gauge:ic('<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/><path d="M4 18h16"/>')
  };
  var docs='return go(\'#/developers\')', apply='return go(\'#/onboarding\')';

  /* Network map: institutions as nodes on a stylised globe, settlement flows as animated arcs (pure SVG + CSS). */
  var N=[[118,150],[178,92],[262,78],[338,118],[372,206],[330,292],[248,330],[160,300],[104,226],[228,196]];
  var F=[[0,4],[1,6],[2,7],[3,8],[9,0],[9,3],[9,5],[5,1],[6,2],[8,4]];
  var arcs=F.map(function(f,i){var a=N[f[0]],b=N[f[1]],mx=(a[0]+b[0])/2,my=(a[1]+b[1])/2-60;
    return '<path class="hx-arc" style="animation-delay:'+(i*0.45).toFixed(2)+'s" d="M'+a[0]+' '+a[1]+' Q'+mx+' '+my+' '+b[0]+' '+b[1]+'"/>';}).join('');
  var nodes=N.map(function(n,i){return '<g><circle class="hx-pulse" style="animation-delay:'+(i*0.3).toFixed(1)+'s" cx="'+n[0]+'" cy="'+n[1]+'" r="5"/><circle cx="'+n[0]+'" cy="'+n[1]+'" r="4.2" fill="var(--teal)"/></g>';}).join('');
  var mapSvg='<svg class="hx-map" viewBox="0 0 440 420" role="img" aria-label="Institutions connected by settlement flows">'+
    '<defs><radialGradient id="hxg" cx="45%" cy="40%" r="60%"><stop offset="0" stop-color="var(--teal)" stop-opacity=".16"/><stop offset="1" stop-color="var(--teal)" stop-opacity="0"/></radialGradient></defs>'+
    '<circle cx="240" cy="205" r="175" fill="url(#hxg)" stroke="var(--line-2)"/>'+
    '<ellipse cx="240" cy="205" rx="175" ry="60" fill="none" stroke="var(--line)"/><ellipse cx="240" cy="205" rx="175" ry="120" fill="none" stroke="var(--line)"/>'+
    '<ellipse cx="240" cy="205" rx="60" ry="175" fill="none" stroke="var(--line)"/><ellipse cx="240" cy="205" rx="120" ry="175" fill="none" stroke="var(--line)"/>'+
    arcs+nodes+'</svg>';

  /* Stats: facts only (owner decision 2026-11-07). Numbers count up when scrolled into view. */
  var stats=[['2','','Settlement assets','USDC + USDT on Solana'],['1:1','','Reserved','Nothing minted, nothing lent'],['64','/64','Sandbox end-to-end checks','Real custody, devnet, both assets'],['0','','Failed sandbox settlements','Every settlement proven on-chain'],['24/7','','On-chain settlement','No cut-off times, no banking hours']];
  var statH=stats.map(function(s){return '<div class="hx-stat reveal"><div class="hx-stat-num gt" data-count="'+s[0]+'">'+s[0]+'<span>'+s[1]+'</span></div><div class="hx-stat-lbl">'+s[2]+'</div><div class="hx-stat-sub">'+s[3]+'</div></div>';}).join('');

  var steps=[[I.key,'Connect','One API key. Your bank joins the network in days, not a year.'],[I.route,'Settle','Submit a settlement. AxLink routes it through custody, executes it on Solana and proves it on-chain.'],[I.book,'Reconcile','A signed webhook carries the proof to your systems. Ledger entries are posted automatically.']];
  var stepH=steps.map(function(s,i){return (i?'<div class="hx-link" aria-hidden="true"><span></span></div>':'')+'<div class="hx-step reveal"><div class="hx-step-ic">'+s[0]+'</div><div class="hx-step-n mono">STEP '+(i+1)+'</div><h4>'+s[1]+'</h4><p>'+s[2]+'</p></div>';}).join('');

  var feats=[[I.vault,'Institutional Custody','Every wallet is its own Fireblocks MPC vault. Keys never sit on AxLink servers.'],[I.coin,'Stablecoin Settlement','USDC and USDT on Solana. A settlement completes only when a Solana node reports it finalized.'],[I.sign,'Signed Webhooks','HMAC-SHA256 signed events with replay protection: deposit.settled, transfer.settled, settlement.received.'],[I.book,'Double-Entry Ledger','Append-only journal. Every movement balances to zero per currency before it is written.'],[I.code,'TypeScript SDK','@axlink/sdk for your backend. 9 resource namespaces, full types, idempotent writes.'],[I.gauge,'Ops Dashboard','Real-time settlement view, stuck queue, reconciliation and a public proof for every settlement.']];
  var featH=feats.map(function(f){return '<div class="card reveal hx-feat"><div class="ic">'+f[0]+'</div><h4>'+f[1]+'</h4><p>'+f[2]+'</p></div>';}).join('');

  var flow=[['Settlement Request','Institution A submits the recipient institution, asset, network and amount, with an idempotency key.'],['Authorization & Compliance','AxLink checks permissions, balance, network, the receiving wallet and risk limits.'],['Funds Reserved','The ledger records an atomic reservation of the amount before anything leaves custody.'],['Blockchain Execution','The custody adapter (Fireblocks) executes the transfer on Solana.'],['Finality Verification','AxLink checks the signature, token mint, destination and finality against a Solana node.'],['Ledger & Reconciliation','Custody records and chain evidence are reconciled with the journal.'],['Institution Notification','Both institutions receive a signed confirmation carrying the on-chain proof.']];
  var flowH=flow.map(function(f,i){return '<li class="hx-flow-step reveal" style="--d:'+(i*0.12).toFixed(2)+'s"><span class="hx-flow-dot mono">'+(i+1)+'</span><div><h5>'+f[0]+'</h5><p>'+f[1]+'</p></div></li>';}).join('');

  function kw(t){return '<span class="hx-k">'+t+'</span>';} function st(t){return '<span class="hx-s">'+t+'</span>';} function cm(t){return '<span class="hx-c">'+t+'</span>';}
  var code=[kw('import')+' { AxLinkClient } '+kw('from')+' '+st("'@axlink/sdk'")+';','',
    kw('const')+' axlink = '+kw('new')+' AxLinkClient({','  baseUrl: '+st("'https://axlink-settlement.onrender.com'")+',','  apiKey:  process.env.AXLINK_API_KEY,','});','',
    cm('// Settle 10,000 USDT to Galaxy Bank'),
    kw('const')+' result = '+kw('await')+' axlink.settlements.create({','  walletId:       '+st("'wal_treasury'")+',','  counterpartyId: '+st("'cp_galaxybank_01'")+',','  asset:          '+st("'USDT_SOL'")+',','  amount:         '+st("'10000'")+',','  reference:      '+st("'INV-2026-001'")+',','  idempotencyKey: '+st("'INV-2026-001'")+',  '+cm('// a retry never pays twice'),'});',
    cm("// { id: '…', status: 'PROCESSING' }  →  'COMPLETED', proof.txHash on finality")].join('\n');

  var inScope=['USDC and USDT custody','Stablecoin deposits and transfers','Institution-to-institution settlement','Custody and ledger reconciliation'];
  var outScope=['Stablecoin-to-fiat conversion','Local bank and mobile money payout','Cross-chain bridging'];
  function li(arr,ok){return arr.map(function(t){return '<li><span class="hx-mark '+(ok?'ok':'no')+'">'+(ok?'&#10003;':'&#8212;')+'</span>'+t+'</li>';}).join('');}

  return siteWrap('Home',
   /* 1 HERO */
   '<section class="hx-hero"><div class="wrap hx-hero-grid">'+
     '<div class="hx-hero-copy"><span class="eyebrow">AxLink Settlement Network</span>'+
     '<h1 class="hx-h1">The Settlement Network for the <span class="gt">World\'s Banks</span></h1>'+
     '<p class="hx-sub">USDC and USDT on Solana. Instant, final, on-chain. Your bank connects once, then settles with any institution on the network.</p>'+
     '<div class="hx-ctas"><a href="javascript:void(0)" onclick="'+apply+'" class="btn btn-primary">Request API Access &#8594;</a><a href="javascript:void(0)" onclick="'+docs+'" class="btn btn-ghost">Read the Docs</a></div></div>'+
     '<div class="hx-hero-art">'+mapSvg+'</div></div>'+
     '<div class="wrap"><div class="hx-trust"><span>Custody via Fireblocks MPC</span><span>Settles on Solana</span><span>USDC by Circle</span><span>USDT by Tether</span><span>Sandbox live</span></div></div></section>'+
   /* 2 NETWORK STATS */
   '<section class="hx-sec hx-tight"><div class="wrap"><div class="hx-stats">'+statH+'</div></div></section>'+
   /* 3 HOW IT WORKS */
   '<section class="hx-sec"><div class="wrap"><div class="hx-head reveal"><span class="eyebrow">How it works</span><h2>Three steps from API key to on-chain proof.</h2></div><div class="hx-steps">'+stepH+'</div></div></section>'+
   /* 4 WHAT BANKS GET */
   '<section class="hx-sec hx-alt"><div class="wrap"><div class="hx-head reveal"><span class="eyebrow">What banks get</span><h2>Institutional infrastructure, not a wallet app.</h2></div><div class="cards c3 hx-feats">'+featH+'</div></div></section>'+
   /* 5 SETTLEMENT FLOW */
   '<section class="hx-sec"><div class="wrap hx-flow-grid"><div class="hx-head reveal" style="text-align:left;margin:0"><span class="eyebrow">Settlement flow</span><h2>Seven checks between request and proof.</h2><p class="lead">Example: Institution A settles 10,000 USDC on Solana to Institution B. Nothing is credited until finality is verified on-chain.</p></div><ol class="hx-flow">'+flowH+'</ol></div></section>'+
   /* 6 SDK */
   '<section class="hx-sec hx-alt"><div class="wrap hx-code-grid"><div class="reveal"><span class="eyebrow">Developers</span><h2 class="hx-h2">Drop the SDK into your backend.</h2><p class="lead">Typed client for every endpoint. Writes are idempotent: the same key never pays twice. Webhooks are verified with one call.</p><div class="hx-ctas"><a href="javascript:void(0)" onclick="'+docs+'" class="btn btn-ghost">API reference &#8594;</a></div></div>'+
     '<div class="hx-code reveal"><div class="hx-code-bar"><i></i><i></i><i></i><span class="mono">settle.ts</span></div><pre><code>'+code+'</code></pre></div></div></section>'+
   /* 7 SCOPE */
   '<section class="hx-sec"><div class="wrap"><div class="hx-head reveal"><span class="eyebrow">Scope</span><h2>Exactly what AxLink does today.</h2><p class="lead">Leg A ends at verified digital-asset receipt by the receiving institution.</p></div>'+
     '<div class="hx-scope reveal"><div><h4>In scope (Leg A)</h4><ul>'+li(inScope,true)+'</ul></div><div><h4>Out of scope</h4><ul>'+li(outScope,false)+'</ul></div></div></div></section>'+
   /* 8 CTA */
   '<section class="hx-cta"><div class="wrap reveal"><h2>Ready to settle on-chain?</h2><p>AxLink is onboarding its founding network members. Apply for API access and go live in days.</p>'+
     '<a href="javascript:void(0)" onclick="'+apply+'" class="btn btn-primary">Apply for API Access &#8594;</a></div></section>'
  );
}
