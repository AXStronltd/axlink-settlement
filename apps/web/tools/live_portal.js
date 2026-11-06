/* ===== LIVE PORTAL (Step 2, slice 6a) =====
   When an institution connects with its API key, the portal stops showing illustrative data and
   renders what /api/v1 returns. Nothing here is a second implementation of the API: every screen is
   a view over one GET, every button is one POST, and the environment is whatever the key is bound to.
   The key lives in sessionStorage only (gone when the tab closes); it is never written to localStorage. */
var LIVE={me:null,wallets:[],balances:null,deposits:[],transfers:[],counterparties:[],endpoints:[],deliveries:{},assets:null,error:null,loading:false};
/* Every string that comes back from the API is HTML-escaped at the boundary (liveSan), before it is
   stored in LIVE. Labels, references, webhook URLs, error messages and operator reasons are all typed
   by someone — a same-tenant key holder, an operator, a custody provider — and the treasury officer
   viewing this page holds a broader key than any of them. Rendering is string concatenation, so the
   boundary is where safety lives; ids are cuids and survive escaping unchanged. */
function liveEsc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
/* For toasts (rendered as text, not HTML) take the escaping back off. */
function liveUnesc(s){ return String(s==null?'':s).replace(/&(amp|lt|gt|quot|#39);/g,function(m,c){ return {amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[c]; }); }
function liveSan(v){ if(typeof v==='string') return liveEsc(v); if(Array.isArray(v)) return v.map(liveSan); if(v&&typeof v==='object'){ var o={}; for(var k in v) if(Object.prototype.hasOwnProperty.call(v,k)) o[k]=liveSan(v[k]); return o; } return v; }
function axBase(){
  // Served from the API (/portal): always same origin, a stored base is ignored. Elsewhere: an https
  // base the user typed (or http://localhost for development) — never a URL parameter.
  if(location.pathname.indexOf('/portal')===0) return location.origin+'/api/v1';
  try{ var b=sessionStorage.getItem('AX_API_BASE'); if(b&&axBaseOk(b)) return b; }catch(e){}
  return null;
}
function axBaseOk(b){ return /^https:\/\/[^\s\/]+(\/[^\s]*)?$/.test(b)||/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?$/.test(b); }
function axKey(){ try{ return sessionStorage.getItem('AX_API_KEY')||''; }catch(e){ return ''; } }
function axApi(method,path,body,headers){
  var base=axBase(); if(!base) return Promise.reject(new Error('No API base configured'));
  var h={'Authorization':'Bearer '+axKey()}; if(body) h['Content-Type']='application/json'; if(headers) for(var k in headers) h[k]=headers[k];
  return fetch(base+path,{method:method,headers:h,body:body?JSON.stringify(body):undefined}).then(function(r){
    return r.text().then(function(t){ var j=null; try{ j=t?JSON.parse(t):null; }catch(e){}
      if(!r.ok){ var err=new Error((j&&j.error&&j.error.message)||('HTTP '+r.status)); /* shown via toast (text node) or escaped at LIVE.error */ err.code=liveEsc((j&&j.error&&j.error.code)||('HTTP_'+r.status)); err.status=r.status; err.details=liveSan(j&&j.error&&j.error.details); throw err; }
      return liveSan(j); });
  });
}
function axIdem(){ try{ return crypto.randomUUID(); }catch(e){ return 'idem-'+Date.now()+'-'+Math.random().toString(36).slice(2); } }
function connectWithKey(key,base){
  key=(key||'').trim(); if(!key){ toast('Paste your API key','!'); return false; }
  base=(base||'').trim().replace(/\/$/,'');
  if(base&&!axBaseOk(base)){ toast('API base must be https:// (or http://localhost for development)','!'); return false; }
  // Nothing is stored until the key has authenticated: a wrong key or base leaves no trace.
  var probe=base||axBase(); if(!probe){ toast('No API base: open the portal from the API (/portal) or set the base URL','!'); return false; }
  fetch(probe+'/institutions/me',{headers:{'Authorization':'Bearer '+key}}).then(function(r){ return r.text().then(function(t){ var j=null; try{ j=t?JSON.parse(t):null; }catch(e){} if(!r.ok) throw new Error((j&&j.error&&j.error.message)||('HTTP '+r.status)); return liveSan(j); }); }).then(function(me){
    try{ sessionStorage.setItem('AX_API_KEY',key); if(base) sessionStorage.setItem('AX_API_BASE',base); }catch(e){}
    LIVE.me=me; LIVE.error=null; ROLE='client'; ENV=me.environment;
    toast('Connected · '+liveUnesc(me.institution.slug)+' · '+me.environment.toLowerCase());
    go('#/app'); refreshLive();
  }).catch(function(e){ LIVE.me=null; toast('Could not connect: '+e.message,'!'); });
  return false;
}
function disconnectLive(){ LIVE={me:null,wallets:[],balances:null,deposits:[],transfers:[],counterparties:[],endpoints:[],deliveries:{},assets:null,error:null,loading:false}; try{ sessionStorage.removeItem('AX_API_KEY'); sessionStorage.removeItem('AX_API_BASE'); }catch(e){} }
function refreshLive(){
  if(!LIVE.me) return Promise.resolve();
  LIVE.loading=true;
  var gets=[['wallets','/wallets'],['balances','/balances'],['deposits','/deposits'],['transfers','/transfers'],['counterparties','/counterparties'],['endpoints','/webhook-endpoints'],['assets','/assets']];
  return Promise.all(gets.map(function(g){ return axApi('GET',g[1]).then(function(v){ LIVE[g[0]]=v; }).catch(function(e){ if(e.status!==403) LIVE.error=liveEsc(e.message); LIVE[g[0]]=Array.isArray(LIVE[g[0]])?[]:null; }); }))
   .then(function(){ return Promise.all((LIVE.endpoints||[]).map(function(ep){ return axApi('GET','/webhook-endpoints/'+ep.id+'/deliveries').then(function(d){ LIVE.deliveries[ep.id]=d; }).catch(function(){}); })); })
   .then(function(){ LIVE.loading=false; render(); });
}
function liveAmt(a){ return a===undefined||a===null?'—':String(a); }
function liveWhen(iso){ if(!iso) return '—'; var d=new Date(iso); var s=(Date.now()-d.getTime())/1000; if(s<60) return 'just now'; if(s<3600) return Math.floor(s/60)+' min ago'; if(s<86400) return Math.floor(s/3600)+' hr ago'; return d.toISOString().slice(0,10); }
function liveBadge(st){ return '<span class="badge badge-'+(st==='COMPLETED'||st==='ACTIVE'||st==='SETTLED'?'completed':st==='FAILED'||st==='DISABLED'||st==='REJECTED'||st==='CANCELLED'||st==='EXPIRED'||st==='ABANDONED'?'failed':'pending')+'">'+st+'</span>'; }
function liveHead(){ return '<div style="background:rgba(46,230,197,.08);border:1px solid rgba(46,230,197,.25);border-radius:8px;padding:8px 14px;font-size:11.5px;color:var(--ink-2);margin-bottom:16px;display:flex;align-items:center;gap:8px;justify-content:space-between"><span>&#9679; Live · '+LIVE.me.institution.slug+' · '+LIVE.me.environment.toLowerCase()+' · '+liveEsc(axBase())+(LIVE.error?' · <span style="color:#f87171">'+LIVE.error+'</span>':'')+'</span><span><button class="btn btn-ghost btn-sm" onclick="refreshLive();toast(\'Refreshing\')">Refresh</button></span></div>'; }
/* ---- screens ---- */
function liveOverview(){
  var b=LIVE.balances?LIVE.balances.balances:[];
  var k=b.map(function(x,i){ return kpiCard('&#9670;',x.symbol+' available',liveAmt(x.available),x.network,'flat',6+i,i?'#34d399':'#2ee6c5'); }).join('');
  var open=(LIVE.transfers||[]).filter(function(t){return t.status==='PROCESSING';}).length;
  return appShell('#/app', liveHead()+pageHead('Overview','Your institution on AxLink — '+LIVE.me.environment.toLowerCase()+' environment, as the API sees it.')+
   '<div class="kpi-cards reveal" style="grid-template-columns:repeat(4,1fr)">'+k+kpiCard('&#9737;','Wallets',String((LIVE.wallets||[]).length),'custody vaults','flat',8,'#a78bfa')+kpiCard('&#8644;','Settlements in flight',String(open),'PROCESSING','flat',5,'#fbbf24')+'</div>'+
   tableCard('Recent deposits',['Instruction','Asset','Amount','Status','Reference','When'],(LIVE.deposits||[]).slice(0,5).map(function(d){ return '<tr><td class="txid">'+d.id+'</td><td>'+d.asset+'</td><td class="mono">'+liveAmt(d.expectedAmount||d.amount)+'</td><td>'+liveBadge(d.status)+'</td><td style="color:var(--ink-2)">'+(d.reference||'—')+'</td><td style="color:var(--ink-3)">'+liveWhen(d.createdAt)+'</td></tr>'; }).join('')||'<tr><td colspan="6" style="color:var(--ink-3)">No deposit instructions yet.</td></tr>')+
   tableCard('Recent settlements',['Transfer','Counterparty','Asset','Amount','Stage','Status','When'],(LIVE.transfers||[]).slice(0,5).map(function(t){ return '<tr><td class="txid">'+t.id+'</td><td>'+(t.counterparty&&t.counterparty.label||'—')+'</td><td>'+t.asset+'</td><td class="mono">'+t.amount+'</td><td><span class="chip" style="padding:2px 8px">'+t.stage+'</span></td><td>'+liveBadge(t.status)+'</td><td style="color:var(--ink-3)">'+liveWhen(t.createdAt)+'</td></tr>'; }).join('')||'<tr><td colspan="7" style="color:var(--ink-3)">No settlements yet.</td></tr>'));
}
function liveWallet(){
  var ws=LIVE.wallets||[];
  var rows=ws.map(function(w){ return '<tr><td style="font-weight:500">'+w.label+'</td><td class="mono" style="font-size:11px;color:var(--teal)">'+w.custody.provider+' · '+w.custody.vaultId+'</td><td class="mono" style="font-size:11px">'+(w.depositAddress||'— not issued —')+'</td><td class="mono">'+w.balances.map(function(b){return b.asset+' '+b.available+(b.drift?' <span style="color:#f87171">drift</span>':'');}).join('<br>')+'</td><td>'+liveBadge(w.status)+'</td></tr>'; }).join('')||'<tr><td colspan="5" style="color:var(--ink-3)">No wallet yet — create one.</td></tr>';
  var b=LIVE.balances?LIVE.balances.balances:[];
  return appShell('#/app/treasury', liveHead()+pageHead('Wallet','Your custody vaults in '+LIVE.me.environment.toLowerCase()+'. Balances are read from the double-entry journal (GET /v1/balances), never from a cache.','<button class="btn btn-ghost btn-sm" onclick="liveOpenDeposit()">Announce a deposit</button><button class="btn btn-primary btn-sm" onclick="liveOpenCreateWallet()">+ New wallet</button>')+
   '<div class="kpi-cards reveal" style="grid-template-columns:repeat(4,1fr)">'+b.map(function(x,i){ return kpiCard('&#9670;',x.symbol+' available',liveAmt(x.available),x.network,'flat',6+i,i?'#34d399':'#2ee6c5'); }).join('')+kpiCard('&#9737;','Wallets',String(ws.length),'custody vaults','flat',8,'#a78bfa')+'</div>'+
   tableCard('Wallets — GET /v1/wallets',['Label','Custody','Deposit address','Balances','Status'],rows)+
   tableCard('Deposit instructions — GET /v1/deposits',['Instruction','Tracking id','Asset','Amount','Status','Finality','When',''],(LIVE.deposits||[]).map(function(d){ return '<tr><td class="txid">'+d.id+'</td><td class="mono" style="font-size:11px">'+(d.trackingId||'')+'</td><td>'+d.asset+'</td><td class="mono">'+liveAmt(d.expectedAmount||d.amount)+'</td><td>'+liveBadge(d.status)+(d.attention?' <span style="color:#f87171">attention</span>':'')+'</td><td style="font-size:12px;color:var(--ink-2)">'+(d.proof&&d.proof.finality||'—')+'</td><td style="color:var(--ink-3)">'+liveWhen(d.createdAt)+'</td><td>'+(d.status==='PROCESSING'&&(d.instructionStatus==='PENDING')?'<button class="btn btn-ghost btn-sm" onclick="liveCancelDeposit(\''+d.id+'\')">Cancel</button>':'')+'</td></tr>'; }).join('')||'<tr><td colspan="8" style="color:var(--ink-3)">No deposit instructions yet.</td></tr>'));
}
function liveOpenCreateWallet(){
  openModal('<h3 style="font-size:19px;margin-bottom:14px">New wallet</h3><div class="field"><label>Label</label><input id="lw-label" placeholder="Treasury"/></div><div class="hint" style="margin-bottom:12px">POST /v1/wallets — a custody vault on solana-mainnet with one deposit address for USDC and USDT.</div><div style="display:flex;gap:10px"><button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="liveCreateWallet()">Create</button></div>');
}
function liveCreateWallet(){ var label=(document.getElementById('lw-label').value||'').trim(); axApi('POST','/wallets',{label:label}).then(function(w){ closeModal(); toast('Wallet '+liveUnesc(w.label)+' created'); refreshLive(); }).catch(function(e){ toast(e.message,'!'); }); }
function liveOpenDeposit(){
  var ws=LIVE.wallets||[]; if(!ws.length){ toast('Create a wallet first','!'); return; }
  openModal('<h3 style="font-size:19px;margin-bottom:14px">Announce a deposit</h3>'+
   '<div class="field"><label>Wallet</label><select id="ld-wallet">'+ws.map(function(w){return '<option value="'+w.id+'">'+w.label+'</option>';}).join('')+'</select></div>'+
   '<div class="grid-2" style="gap:14px"><div class="field"><label>Asset</label><select id="ld-asset"><option>USDC_SOL</option><option>USDT_SOL</option></select></div><div class="field"><label>Amount (exact)</label><input id="ld-amount" placeholder="12.5"/></div></div>'+
   '<div class="field"><label>Your reference</label><input id="ld-ref" placeholder="INV-2026-0142"/><div class="hint">POST /v1/deposits — returns the address and a tracking id to put in the sender\'s transfer.</div></div>'+
   '<div style="display:flex;gap:10px"><button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="liveCreateDeposit()">Create instruction</button></div>');
}
function liveCreateDeposit(){
  var body={walletId:document.getElementById('ld-wallet').value,asset:document.getElementById('ld-asset').value,amount:(document.getElementById('ld-amount').value||'').trim()}; var ref=(document.getElementById('ld-ref').value||'').trim(); if(ref) body.reference=ref;
  axApi('POST','/deposits',body).then(function(d){ closeModal(); openModal('<h3 style="font-size:19px;margin-bottom:10px">Deposit instruction created</h3><div class="hint" style="margin-bottom:8px">Send exactly '+body.amount+' '+body.asset+' on Solana to:</div><pre style="background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:12px;font-size:12px;word-break:break-all;white-space:pre-wrap">'+d.depositAddress+'</pre><div class="hint">Tracking id (put it in the transfer\'s external id): <b class="mono">'+d.trackingId+'</b><br>Valid until '+(d.expiresAt||'').replace('T',' ').slice(0,16)+' · COMPLETED when a Solana node reports the receipt finalized.</div><div style="margin-top:12px"><button class="btn btn-primary" style="width:100%;justify-content:center" onclick="closeModal()">Done</button></div>'); refreshLive(); }).catch(function(e){ toast(e.message,'!'); });
}
function liveCancelDeposit(id){ axApi('POST','/deposits/'+id+'/cancel').then(function(){ toast('Instruction cancelled'); refreshLive(); }).catch(function(e){ toast(e.message,'!'); }); }
function liveSettlements(){
  var rows=(LIVE.transfers||[]).map(function(t){ return '<tr><td class="txid">'+t.id+'</td><td>'+(t.counterparty&&t.counterparty.label||'—')+(t.counterparty&&t.counterparty.address?' <span class="mono" style="font-size:10.5px;color:var(--ink-3)">'+t.counterparty.address.slice(0,4)+'…'+t.counterparty.address.slice(-4)+'</span>':'')+'</td><td class="mono">'+t.amount+'</td><td style="color:var(--ink-2)">'+t.asset+'</td><td><span class="chip" style="padding:2px 8px">'+t.stage+'</span></td><td>'+liveBadge(t.status)+(t.attention?' <span style="color:#f87171" title="'+(t.reason||'')+'">attention</span>':'')+'</td><td style="font-size:12px;color:var(--ink-2)">'+(t.proof?(t.proof.finality+(t.proof.txHash?' · <a href="'+t.proof.explorerUrl+'" target="_blank" rel="noopener" style="color:var(--teal)">tx</a>':'')):'—')+'</td><td style="color:var(--ink-3)">'+liveWhen(t.createdAt)+'</td><td>'+(t.stage==='AWAITING_APPROVAL'?'<button class="btn btn-ghost btn-sm" onclick="liveCancelTransfer(\''+t.id+'\')">Cancel</button>':'')+'</td></tr>'; }).join('')||'<tr><td colspan="9" style="color:var(--ink-3)">No settlements yet.</td></tr>';
  var open=(LIVE.transfers||[]).filter(function(t){return t.stage==='AWAITING_APPROVAL';}).length;
  return appShell('#/app/payments', liveHead()+pageHead('Settlements','Outbound settlements from your wallet to an approved counterparty — GET /v1/transfers. COMPLETED only when a Solana node reports the transfer finalized.','<button class="btn btn-primary btn-sm" onclick="liveOpenSettlement()">+ New settlement</button>')+
   '<div class="kpi-cards reveal" style="grid-template-columns:repeat(4,1fr)">'+kpiCard('&#8644;','Settlements',String((LIVE.transfers||[]).length),'in this environment','flat',6)+kpiCard('&#10003;','Completed',String((LIVE.transfers||[]).filter(function(t){return t.status==='COMPLETED';}).length),'finalized','flat',7,'#34d399')+kpiCard('&#9202;','Awaiting approval',String(open),'operator queue','flat',5,'#fbbf24')+kpiCard('&#9888;','Attention',String((LIVE.transfers||[]).filter(function(t){return t.attention;}).length),'needs a person','flat',8,'#f87171')+'</div>'+
   tableCard('Transfers',['ID','Counterparty','Amount','Asset','Stage','Status','Finality','When',''],rows));
}
function liveOpenSettlement(){
  var ws=LIVE.wallets||[]; var cps=(LIVE.counterparties||[]).filter(function(c){return c.status==='ACTIVE';});
  if(!ws.length){ toast('Create a wallet first','!'); return; } if(!cps.length){ toast('Register and approve a counterparty first','!'); return; }
  openModal('<h3 style="font-size:19px;margin-bottom:14px">New settlement</h3>'+
   '<div class="field"><label>From wallet</label><select id="ls-wallet">'+ws.map(function(w){return '<option value="'+w.id+'">'+w.label+' · '+w.balances.map(function(b){return b.asset+' '+b.available;}).join(' · ')+'</option>';}).join('')+'</select></div>'+
   '<div class="field"><label>Counterparty (ACTIVE only)</label><select id="ls-cp">'+cps.map(function(c){return '<option value="'+c.id+'">'+c.label+' — '+c.address.slice(0,6)+'…'+c.address.slice(-6)+'</option>';}).join('')+'</select></div>'+
   '<div class="grid-2" style="gap:14px"><div class="field"><label>Amount (exact, in the asset)</label><input id="ls-amount" placeholder="120.5"/></div><div class="field"><label>Asset</label><select id="ls-asset"><option>USDC_SOL</option><option>USDT_SOL</option></select></div></div>'+
   '<div class="field"><label>Your reference</label><input id="ls-ref" placeholder="SETTLE-2026-0442"/><div class="hint">POST /v1/transfers with an Idempotency-Key · above the approval threshold it waits for an operator.</div></div>'+
   '<div style="display:flex;gap:10px"><button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="liveCreateSettlement()">Create settlement</button></div>');
}
function liveCreateSettlement(){
  var body={walletId:document.getElementById('ls-wallet').value,counterpartyId:document.getElementById('ls-cp').value,asset:document.getElementById('ls-asset').value,amount:(document.getElementById('ls-amount').value||'').trim()}; var ref=(document.getElementById('ls-ref').value||'').trim(); if(ref) body.reference=ref;
  axApi('POST','/transfers',body,{'Idempotency-Key':axIdem()}).then(function(t){ closeModal(); toast('Settlement '+t.id+' · '+t.stage); refreshLive(); }).catch(function(e){ toast(e.message+(e.details&&e.details.available!==undefined?' (available '+e.details.available+')':''),'!'); });
}
function liveCancelTransfer(id){ axApi('POST','/transfers/'+id+'/cancel').then(function(){ toast('Settlement cancelled'); refreshLive(); }).catch(function(e){ toast(e.message,'!'); }); }
function liveCounterparties(){
  var rows=(LIVE.counterparties||[]).map(function(c){ return '<tr><td style="font-weight:500">'+c.label+'</td><td style="color:var(--ink-2)">'+c.network+'</td><td class="mono" style="font-size:11px;color:var(--teal)" title="'+(c.address||'')+'">'+(c.kind==='NETWORK'?'<span class="chip" style="padding:2px 8px"><span class="d" style="background:var(--teal)"></span>network · '+c.participant+'</span>':(c.address.slice(0,8)+'…'+c.address.slice(-8)))+'</td><td style="color:var(--ink-2)">'+(c.kind==='NETWORK'?'inside AxLink custody':c.custodyWhitelisted?'custody whitelisted':(c.status==='PENDING_APPROVAL'?'awaiting operator':c.status==='ACTIVE'?'sandbox auto':'—'))+'</td><td>'+liveBadge(c.status)+'</td><td>'+(c.status==='ACTIVE'?'<button class="btn btn-primary btn-sm" onclick="liveOpenSettlement()">Settle</button> <button class="btn btn-ghost btn-sm" onclick="liveDisableCounterparty(\''+c.id+'\')">Disable</button>':'')+'</td></tr>'; }).join('')||'<tr><td colspan="6" style="color:var(--ink-3)">No counterparties yet — register one.</td></tr>';
  return appShell('#/app/contacts', liveHead()+pageHead('Counterparties','Who you may settle to — GET /v1/counterparties. A network participant (another AxLink institution) is active at once and settles inside custody. An external address: sandbox ACTIVE at once, production after an operator confirms custody whitelisting.','<button class="btn btn-primary btn-sm" onclick="liveOpenCounterparty()">+ Register counterparty</button>')+
   tableCard('Counterparties',['Label','Network','Address','Approval','Status',''],rows));
}
function liveOpenCounterparty(){
  openModal('<h3 style="font-size:19px;margin-bottom:14px">Register counterparty</h3><div class="field"><label>Label</label><input id="lc-label" placeholder="Partner Bank"/></div><div class="field"><label>Kind</label><select id="lc-kind" onchange="document.getElementById(\'lc-ext\').style.display=this.value===\'EXTERNAL\'?\'\':\'none\';document.getElementById(\'lc-net\').style.display=this.value===\'NETWORK\'?\'\':\'none\'"><option value="EXTERNAL">External address — outside AxLink custody</option><option value="NETWORK">Network participant — another AxLink institution (settles inside custody)</option></select></div><div class="field" id="lc-net" style="display:none"><label>Participant slug</label><input id="lc-part" placeholder="e.g. axlink-reference"/><div class="hint">The institution\'s AxLink slug; it must be active and hold a wallet in this environment.</div></div><div class="field" id="lc-ext"><label>Solana address</label><input id="lc-addr" placeholder="base58 address"/></div><div class="field"><label>Note (optional)</label><input id="lc-note" placeholder="Settlement account at Partner Bank"/><div class="hint">POST /v1/counterparties — AxLink\'s own custody wallets are refused here.</div></div><div style="display:flex;gap:10px"><button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="liveRegisterCounterparty()">Register</button></div>');
}
function liveRegisterCounterparty(){ var kind=(document.getElementById('lc-kind')||{}).value||'EXTERNAL'; var body={label:(document.getElementById('lc-label').value||'').trim()}; if(kind==='NETWORK') body.participant=(document.getElementById('lc-part').value||'').trim(); else body.address=(document.getElementById('lc-addr').value||'').trim(); var n=(document.getElementById('lc-note').value||'').trim(); if(n) body.note=n; axApi('POST','/counterparties',body).then(function(c){ closeModal(); toast('Counterparty '+liveUnesc(c.label)+' · '+c.status); refreshLive(); }).catch(function(e){ toast(e.message,'!'); }); }
function liveDisableCounterparty(id){ axApi('DELETE','/counterparties/'+id).then(function(){ toast('Counterparty disabled'); refreshLive(); }).catch(function(e){ toast(e.message,'!'); }); }
function liveWebhooks(){
  var eps=LIVE.endpoints||[];
  var epRows=eps.map(function(ep){ return '<tr><td class="mono" style="font-size:12px;color:var(--teal)">'+ep.url+'</td><td style="color:var(--ink-2)">'+(ep.events||[]).join(', ')+'</td><td>'+liveBadge(ep.status)+'</td><td style="color:var(--ink-3)">'+liveWhen(ep.createdAt)+'</td><td>'+(ep.status==='ACTIVE'?'<button class="btn btn-ghost btn-sm" onclick="liveDisableEndpoint(\''+ep.id+'\')">Disable</button>':'')+'</td></tr>'; }).join('')||'<tr><td colspan="5" style="color:var(--ink-3)">No endpoint yet — add one to receive signed events.</td></tr>';
  var dl=[]; eps.forEach(function(ep){ (LIVE.deliveries[ep.id]||[]).forEach(function(d){ dl.push(d); }); }); dl.sort(function(a,b){ return a.createdAt<b.createdAt?1:-1; });
  var dRows=dl.slice(0,50).map(function(d){ return '<tr><td class="txid">'+d.id+'</td><td>'+d.type+'</td><td style="color:var(--ink-2)">'+(d.lastStatus||'—')+(d.status==='PENDING'&&d.nextAttemptAt?' → retry '+liveWhen(d.nextAttemptAt).replace(' ago',''):'')+'</td><td style="color:var(--ink-3)">'+liveWhen(d.createdAt)+'</td><td>'+liveBadge(d.status==='DELIVERED'?'COMPLETED':d.status==='ABANDONED'||d.status==='FAILED'?'FAILED':'PROCESSING')+'</td></tr>'; }).join('')||'<tr><td colspan="5" style="color:var(--ink-3)">No deliveries yet.</td></tr>';
  return appShell('#/app/webhooks', liveHead()+pageHead('Webhooks','Signed event deliveries for '+LIVE.me.environment.toLowerCase()+' — GET /v1/webhook-endpoints. Events: deposit.received · settled · rejected · expired · transfer.submitted · settled · failed.','<button class="btn btn-primary btn-sm" onclick="liveOpenEndpoint()">+ Add endpoint</button>')+
   tableCard('Endpoints',['URL','Events','Status','Created',''],epRows)+tableCard('Recent deliveries',['Event','Type','Response','When','Status'],dRows));
}
function liveOpenEndpoint(){
  openModal('<h3 style="font-size:19px;margin-bottom:14px">Add webhook endpoint</h3><div class="field"><label>HTTPS URL</label><input id="le-url" placeholder="https://api.yourbank.com/axlink/events"/><div class="hint">POST /v1/webhook-endpoints — the signing secret is shown once. Private and link-local hosts are refused.</div></div><div style="display:flex;gap:10px"><button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="liveCreateEndpoint()">Add</button></div>');
}
function liveCreateEndpoint(){ axApi('POST','/webhook-endpoints',{url:(document.getElementById('le-url').value||'').trim()}).then(function(ep){ closeModal(); openModal('<h3 style="font-size:19px;margin-bottom:10px">Endpoint added</h3><div class="hint" style="margin-bottom:8px">Signing secret — shown once, store it now:</div><pre style="background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:12px;font-size:12px;word-break:break-all;white-space:pre-wrap">'+ep.secret+'</pre><div class="hint">Verify <span class="mono">X-AxLink-Signature: t=&lt;unix&gt;,v1=HMAC-SHA256(secret, t + "." + body)</span></div><div style="margin-top:12px"><button class="btn btn-primary" style="width:100%;justify-content:center" onclick="closeModal()">Stored</button></div>'); refreshLive(); }).catch(function(e){ toast(e.message,'!'); }); }
function liveDisableEndpoint(id){ axApi('DELETE','/webhook-endpoints/'+id).then(function(){ toast('Endpoint disabled'); refreshLive(); }).catch(function(e){ toast(e.message,'!'); }); }
function liveDevelopers(){
  var me=LIVE.me; var base=axBase();
  var code='GET '+base+'/institutions/me\nAuthorization: Bearer '+axKey().slice(0,14)+'…\n\n200 OK\n'+JSON.stringify(me,null,2);
  var ep=[['GET','/institutions/me'],['GET','/assets'],['POST','/wallets'],['POST','/custody/deposit-addresses'],['GET','/balances'],['POST','/deposits'],['GET','/settlements/{id}'],['GET','/ledger/entries'],['POST','/counterparties'],['POST','/transfers'],['POST','/settlements'],['POST','/webhook-endpoints']].map(function(e){ return '<div style="display:flex;align-items:center;gap:10px"><span class="badge badge-'+(e[0]==='GET'?'review':'active')+'" style="min-width:44px;justify-content:center">'+e[0]+'</span><span class="mono" style="color:var(--ink);font-size:12px">'+e[1]+'</span></div>'; }).join('');
  return appShell('#/app/developers', liveHead()+pageHead('Developers','Your credential as the API sees it. Full reference: <a href="'+base.replace(/\/v1$/,'')+'/docs" target="_blank" rel="noopener" style="color:var(--teal)">'+base.replace(/\/v1$/,'')+'/docs</a>')+
   '<div class="grid-2" style="gap:14px"><div class="chart-card reveal"><h4 style="margin-bottom:8px">Who am I</h4><pre style="background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:14px;font-size:11.5px;line-height:1.55;overflow-x:auto;color:var(--ink)">'+code.replace(/</g,'&lt;')+'</pre></div><div class="chart-card reveal d1"><h4 style="margin-bottom:8px">Endpoints (all live)</h4><div style="display:grid;gap:8px">'+ep+'</div><div class="hint" style="margin-top:10px">Your scopes: <span class="mono">'+(me.scopes||[]).join(' ')+'</span></div></div></div>');
}
/* restore a session on reload (same tab) */
(function(){ if(axKey()&&axBase()){ axApi('GET','/institutions/me').then(function(me){ LIVE.me=me; ROLE='client'; ENV=me.environment; if(CURRENT.indexOf('#/app')!==0) CURRENT='#/app'; refreshLive(); }).catch(function(){ disconnectLive(); }); } })();
/* deep links: #/app/treasury etc. open the screen directly (the in-page router ignored the URL hash before) */
(function(){ function fromHash(){ var h=location.hash; if(h&&ROUTES[h]&&CURRENT!==h){ CURRENT=h; render(); } } window.addEventListener('hashchange',fromHash); if(location.hash&&ROUTES[location.hash]){ CURRENT=location.hash; render(); } })();

/* ===== LIVE OPERATOR CONSOLE (Step 2, slice 6b) =====
   AxLink staff connect with the operator key (OPS_API_KEY). Three screens go live: Alerts = the
   exception queue, Approvals = transfers and counterparties awaiting a decision, Providers = adapters
   and health. Same rules as the institution side: the key lives in sessionStorage only, every value
   from the API is escaped at the boundary, every button is one call. */
var OPS={on:false,exceptions:null,summary:null,pending:[],pendingCps:[],providers:[],error:null};
function opsBase(){ return location.pathname.indexOf('/portal')===0?location.origin+'/api/settlement':null; }
function opsKey(){ try{ return sessionStorage.getItem('AX_OPS_KEY')||''; }catch(e){ return ''; } }
function opsApi(method,path,body){
  var base=opsBase(); if(!base) return Promise.reject(new Error('Operator console is available when the portal is served by the API (/portal)'));
  var h={'Authorization':'Bearer '+opsKey()}; if(body) h['Content-Type']='application/json';
  return fetch(base+path,{method:method,headers:h,body:body?JSON.stringify(body):undefined}).then(function(r){ return r.text().then(function(t){ var j=null; try{ j=t?JSON.parse(t):null; }catch(e){}
    if(!r.ok){ var m=(j&&j.error&&(j.error.message||j.error))||('HTTP '+r.status); throw new Error(typeof m==='string'?m:('HTTP '+r.status)); } return liveSan(j); }); });
}
function connectAsOperator(key){
  key=(key||'').trim(); if(!key){ toast('Paste the operator key','!'); return false; }
  var base=opsBase(); if(!base){ toast('Open the portal from the API (/portal) to use the operator console','!'); return false; }
  fetch(base+'/providers',{headers:{'Authorization':'Bearer '+key}}).then(function(r){ if(!r.ok) throw new Error(r.status===401?'Operator key not accepted':'HTTP '+r.status); return r.json(); }).then(function(){
    try{ sessionStorage.setItem('AX_OPS_KEY',key); }catch(e){}
    OPS.on=true; OPS.error=null; ROLE='operator'; toast('Operator console connected'); go('#/app/alerts'); refreshOps();
  }).catch(function(e){ OPS.on=false; toast('Could not connect: '+e.message,'!'); });
  return false;
}
function disconnectOps(){ OPS={on:false,exceptions:null,summary:null,pending:[],pendingCps:[],providers:[],error:null}; try{ sessionStorage.removeItem('AX_OPS_KEY'); }catch(e){} }
function refreshOps(){
  if(!OPS.on) return Promise.resolve();
  return Promise.all([
    opsApi('GET','/exceptions?status=OPEN').then(function(v){ OPS.exceptions=v.exceptions; OPS.summary=v.summary; }),
    opsApi('GET','/transfers/pending').then(function(v){ OPS.pending=v; }),
    opsApi('GET','/counterparties/pending').then(function(v){ OPS.pendingCps=v; }),
    opsApi('GET','/providers?health=true').then(function(v){ OPS.providers=v.providers||[]; }),
  ]).catch(function(e){ OPS.error=liveEsc(e.message); }).then(function(){ render(); });
}
function opsHead(){ return '<div style="background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.3);border-radius:8px;padding:8px 14px;font-size:11.5px;color:var(--ink-2);margin-bottom:16px;display:flex;align-items:center;gap:8px"><span style="width:7px;height:7px;border-radius:50%;background:#a78bfa;display:inline-block"></span>Operator console · live · '+liveEsc(opsBase())+(OPS.error?' · <span style="color:#f87171">'+OPS.error+'</span>':'')+'<span style="margin-left:auto"><button class="btn btn-ghost btn-sm" onclick="refreshOps()">Refresh</button></span></div>'; }
function opsSevBadge(s){ return '<span class="badge badge-'+(s==='CRITICAL'?'high':s==='WARN'?'medium':'low')+'">'+s+'</span>'; }
function opsAlerts(){
  var xs=OPS.exceptions||[]; var sm=OPS.summary||{open:0,acknowledged:0,critical:0,warn:0,info:0};
  var rows=xs.map(function(x){ return '<tr><td>'+opsSevBadge(x.severity)+'</td><td style="font-weight:500">'+x.kind+'</td><td class="mono" style="font-size:11px" title="'+x.subject+'">'+x.subject.slice(0,28)+(x.subject.length>28?'…':'')+'</td><td style="color:var(--ink-2)">'+(x.currency||'—')+'</td><td class="mono" style="font-size:11px">'+(x.expected!=null?x.expected:'—')+' / '+(x.actual!=null?x.actual:'—')+'</td><td style="color:var(--ink-2)">'+x.occurrences+'×</td><td>'+liveBadge(x.status==='ACKNOWLEDGED'?'PROCESSING':'FAILED').replace('>FAILED<','>OPEN<').replace('>PROCESSING<','>ACKNOWLEDGED<')+'</td><td>'+(x.status==='OPEN'?'<button class="btn btn-ghost btn-sm" onclick="opsAck(\''+x.id+'\')">Acknowledge</button> ':'')+'<button class="btn btn-primary btn-sm" onclick="opsOpenResolve(\''+x.id+'\')">Resolve</button></td></tr>'; }).join('')||'<tr><td colspan="8" style="color:var(--ink-3)">No open exceptions — the books agree.</td></tr>';
  return appShell('#/app/alerts', opsHead()+pageHead('Exceptions','Everything that needs a person: reconciliation breaks (one line per subject, bumped when it recurs, closed automatically when a run no longer sees it) and transfers where custody and the chain disagree. GET /api/settlement/exceptions.','<button class="btn btn-ghost btn-sm" onclick="opsRunRecon()">Run reconciliation</button>')+
   '<div class="kpi-cards reveal" style="grid-template-columns:repeat(4,1fr)">'+
   kpiCard('&#9650;','Open','' +sm.open,'require action','flat',4,'#f87171')+
   kpiCard('&#9673;','Acknowledged',''+sm.acknowledged,'being worked','flat',5,'#fbbf24')+
   kpiCard('&#9670;','Critical',''+sm.critical,'books not trustworthy until resolved','flat',6,'#f87171')+
   kpiCard('&#9679;','Warnings',''+sm.warn,'','flat',7,'#38bdf8')+'</div>'+
   tableCard('Open exceptions',['Severity','Kind','Subject','Asset','Expected / actual','Seen','Status',''],rows));
}
function opsAck(id){ opsApi('POST','/exceptions/'+id+'/acknowledge',{}).then(function(){ toast('Acknowledged'); refreshOps(); }).catch(function(e){ toast(e.message,'!'); }); }
function opsOpenResolve(id){ openModal('<h3 style="font-size:19px;margin-bottom:14px">Resolve exception</h3><div class="field"><label>Resolution (required, kept on record)</label><input id="ox-note" placeholder="What was found and what was done"/></div><div style="display:flex;gap:10px"><button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="closeModal()">Cancel</button><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="opsResolve(\''+id+'\')">Resolve</button></div>'); }
function opsResolve(id){ var note=(document.getElementById('ox-note').value||'').trim(); opsApi('POST','/exceptions/'+id+'/resolve',{resolution:note}).then(function(){ closeModal(); toast('Resolved'); refreshOps(); }).catch(function(e){ toast(e.message,'!'); }); }
function opsRunRecon(){ toast('Reconciliation running…'); opsApi('POST','/reconcile',{kind:'FULL'}).then(function(r){ toast('Run '+(r.status||'done')+' · '+(r.breaks||0)+' break(s)'); refreshOps(); }).catch(function(e){ toast(e.message,'!'); }); }
function opsApprovals(){
  var ts=OPS.pending||[]; var cps=OPS.pendingCps||[];
  var tRows=ts.map(function(t){ return '<tr><td class="txid">'+t.id+'</td><td>'+t.institution+' · '+t.environment+'</td><td>'+(t.counterparty&&t.counterparty.label||'')+'</td><td class="mono" style="font-size:12px">'+t.amount+' '+t.asset+'</td><td style="font-size:11.5px;color:var(--ink-2)">'+(t.policy?('available '+(t.policy.available||'?')+' · limit '+(t.policy.maxPerTransfer||'?')):'')+'</td><td><button class="btn btn-primary btn-sm" onclick="opsDecide(\'transfers\',\''+t.id+'\',\'approve\')">Approve</button> <button class="btn btn-ghost btn-sm" onclick="opsDecide(\'transfers\',\''+t.id+'\',\'reject\')">Reject</button></td></tr>'; }).join('')||'<tr><td colspan="6" style="color:var(--ink-3)">No transfers awaiting approval.</td></tr>';
  var cRows=cps.map(function(c){ return '<tr><td>'+c.institution+' · '+c.environment+'</td><td style="font-weight:500">'+c.label+'</td><td class="mono" style="font-size:11px" title="'+c.address+'">'+c.address.slice(0,10)+'…'+c.address.slice(-6)+'</td><td style="color:var(--ink-2)">'+(c.note||'')+'</td><td><button class="btn btn-primary btn-sm" onclick="opsApproveCp(\''+c.id+'\')">Approve (whitelisted at custodian)</button> <button class="btn btn-ghost btn-sm" onclick="opsDecide(\'counterparties\',\''+c.id+'\',\'reject\')">Reject</button></td></tr>'; }).join('')||'<tr><td colspan="5" style="color:var(--ink-3)">No counterparties awaiting approval.</td></tr>';
  return appShell('#/app/approvals', opsHead()+pageHead('Approvals','Four-eyes on money out: an institution asks, an operator approves. Approving a transfer writes its journal entry; nothing leaves custody before that. Approving a counterparty records your attestation that the address is whitelisted at the custodian.','')+
   tableCard('Transfers awaiting approval — GET /api/settlement/transfers/pending',['Transfer','Institution','Counterparty','Amount','Policy',''],tRows)+'<div style="height:14px"></div>'+
   tableCard('Counterparties awaiting approval (production) — GET /api/settlement/counterparties/pending',['Institution','Label','Address','Note',''],cRows));
}
function opsDecide(kind,id,action){ var body={}; if(action==='reject'){ var r=prompt('Reason for rejection (kept on record):'); if(r===null) return; body.reason=r; } opsApi('POST','/'+kind+'/'+id+'/'+action,body).then(function(){ toast(action==='approve'?'Approved':'Rejected'); refreshOps(); }).catch(function(e){ toast(e.message,'!'); }); }
function opsApproveCp(id){ if(!confirm('Confirm: this address has been whitelisted at the custodian (Fireblocks TAP). This is recorded as your attestation.')) return; opsApi('POST','/counterparties/'+id+'/approve',{custodyWhitelisted:true}).then(function(){ toast('Counterparty approved'); refreshOps(); }).catch(function(e){ toast(e.message,'!'); }); }
function opsProviders(){
  var rows=(OPS.providers||[]).map(function(p){ return '<tr><td style="font-weight:500">'+p.role+'</td><td class="mono" style="font-size:12px;color:var(--teal)">'+(p.provider||'—')+'</td><td>'+(p.configured===true?'<span class="badge badge-completed">configured</span>':p.configured===false?'<span class="badge badge-pending">sandbox stub</span>':'—')+'</td><td>'+(p.health?(p.health.ok?'<span class="badge badge-completed">ok</span>':'<span class="badge badge-failed">down</span>'):'—')+'</td><td style="color:var(--ink-2);font-size:12px">'+(p.health&&p.health.detail?p.health.detail:'')+'</td></tr>'; }).join('');
  return appShell('#/app/providers', opsHead()+pageHead('Providers','Every provider is an adapter behind a port; this is GET /api/settlement/providers with live health. "sandbox stub" means no credentials are set on this deployment.','')+
   tableCard('Adapters',['Role','Provider','Credentials','Health','Detail'],rows));
}
(function(){ if(opsKey()&&opsBase()){ opsApi('GET','/providers').then(function(){ OPS.on=true; ROLE='operator'; if(CURRENT.indexOf('#/app')!==0) CURRENT='#/app/alerts'; refreshOps(); }).catch(function(){ disconnectOps(); }); } })();
