function onboarding(){
  /* Self-service SANDBOX signup — real: POST /v1/onboarding/sandbox. Production access is never self-service. */
  var r=ONB.result;
  var steps=['Your institution','Dashboard','API keys (when you integrate)','Go live (KYB + 2FA)'];
  var at=r?2:1;
  var stepH='<div class="steps">'+steps.map(function(s,i){var cls=(i+1<at?'done':(i+1===at?'active':''));return '<div class="st '+cls+'"><span class="num">'+(i+1<at?'&#10003;':(i+1))+'</span><span class="lb">'+s+'</span></div>'+(i<steps.length-1?'<div class="line '+(i+1<at?'done':'')+'"></div>':'');}).join('')+'</div>';
  var body;
  if(!r){
    var countries=[['KE','Kenya'],['NG','Nigeria'],['GH','Ghana'],['ZA','South Africa'],['EG','Egypt'],['ET','Ethiopia'],['SO','Somalia'],['TZ','Tanzania'],['UG','Uganda'],['RW','Rwanda'],['AE','United Arab Emirates'],['SA','Saudi Arabia'],['QA','Qatar'],['BH','Bahrain'],['GB','United Kingdom'],['US','United States'],['SG','Singapore'],['DE','Germany'],['FR','France'],['NL','Netherlands']];
    body='<h2 style="font-size:24px;margin-bottom:6px">Create your sandbox account</h2>'+
    '<p class="lead" style="font-size:14px;margin-bottom:20px">Try AxLink end to end with test tokens on Solana devnet: real Fireblocks sandbox custody, no real money. You are signed in to your dashboard as soon as you sign up.</p>'+
    '<div class="field"><label for="ob-name">Legal entity name</label><input id="ob-name" maxlength="200" placeholder="e.g. Galaxy Bank Ltd" autocomplete="organization"/></div>'+
    '<div class="grid-2" style="gap:14px"><div class="field"><label for="ob-kind">Institution type</label><select id="ob-kind"><option value="BANK">Bank</option><option value="PSP">Payment service provider</option><option value="FINTECH">Fintech</option><option value="EXCHANGE">Exchange</option><option value="OTHER">Other</option></select></div>'+
    '<div class="field"><label for="ob-country">Country of registration</label><select id="ob-country">'+countries.map(function(c){return '<option value="'+c[0]+'">'+c[1]+'</option>';}).join('')+'</select></div></div>'+
    '<div class="grid-2" style="gap:14px"><div class="field"><label for="ob-contact">Your name</label><input id="ob-contact" maxlength="120" autocomplete="name"/></div>'+
    '<div class="field"><label for="ob-email">Work email</label><input id="ob-email" type="email" maxlength="200" placeholder="you@institution.com" autocomplete="email"/></div></div>'+
    '<div class="grid-2" style="gap:14px"><div class="field"><label for="ob-pass">Password</label><input id="ob-pass" type="password" autocomplete="new-password" placeholder="12+ characters, letters and digits"/></div>'+
    '<div class="field"><label for="ob-pass2">Confirm password</label><input id="ob-pass2" type="password" autocomplete="new-password"/></div></div>'+
    '<label style="display:flex;gap:10px;align-items:flex-start;font-size:13px;color:var(--ink-2);margin:4px 0 16px;cursor:pointer"><input id="ob-ack" type="checkbox" style="margin-top:3px"/> I understand this is a sandbox: test tokens only, no real funds. Production access requires KYB with AxLink.</label>'+
    '<button id="ob-submit" class="btn btn-primary" style="width:100%;justify-content:center" onclick="return onbSubmit()">Create sandbox account &#8594;</button>'+
    '<p style="text-align:center;font-size:13px;color:var(--ink-3);margin-top:16px">Already have a key? <a href="javascript:void(0)" onclick="return go(\'#/signin\')" style="color:var(--teal);font-weight:600">Sign in</a></p>';
  }else{
    body='<div style="display:flex;gap:14px;align-items:center;margin-bottom:16px"><div style="width:48px;height:48px;border-radius:50%;background:rgba(52,211,153,.14);color:var(--green);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">&#10003;</div>'+
    '<div><h2 style="font-size:22px">'+r.legalName+' is on the sandbox</h2><p style="color:var(--ink-3);font-size:13px;margin-top:2px">Institution id <span class="mono">'+r.slug+'</span> · environment SANDBOX</p></div></div>'+
    '<div class="field"><label>Your sandbox API key: shown once, store it now</label>'+
    '<div style="display:flex;gap:8px"><input id="ob-key" class="mono" readonly value="'+r.apiKey+'" style="font-size:12.5px"/><button class="btn btn-ghost btn-sm" onclick="onbCopy()">Copy</button></div>'+
    '<div class="hint">Keep it in your secret manager. AxLink stores only a hash and cannot show it again.</div></div>'+
    '<button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:6px" onclick="return onbOpenDashboard()">Open my dashboard &#8594;</button>'+
    '<div style="margin-top:20px;padding:14px 16px;border:1px solid var(--line);border-radius:10px;font-size:13px;color:var(--ink-2);line-height:1.6"><b style="color:var(--ink)">Next in the dashboard:</b> create a wallet (a Fireblocks sandbox vault), announce a deposit, register a counterparty bank and settle to it. <br/><b style="color:var(--ink)">Going live</b> is not self-service: AxLink operations completes KYB with you, then enables production and issues a live key.</div>';
  }
  return siteHeader('')+'<div class="site-body">'+
   '<section style="padding:50px 0 90px;min-height:70vh"><div class="wrap" style="max-width:680px"><span class="eyebrow reveal">Sandbox access</span><h1 class="reveal d1" style="font-size:34px;margin:14px 0 8px">Get your institution on the network</h1>'+
   '<div class="reveal d2">'+stepH+'</div>'+
   '<div class="panel reveal d2" style="padding:28px">'+body+'</div>'+
   '<p style="text-align:center;color:var(--ink-3);font-size:12px;margin-top:20px">AxLink sandbox · Fireblocks sandbox custody · Solana devnet · test tokens only</p></div></section>'+
   siteFooter()+'</div>';
}
function onbSubmit(){
  var v=function(id){var e=document.getElementById(id);return e?(e.value||'').trim():'';};
  var pw=(document.getElementById('ob-pass')||{}).value||'', pw2=(document.getElementById('ob-pass2')||{}).value||'';
  var data={legalName:v('ob-name'),kind:v('ob-kind'),country:v('ob-country'),contactName:v('ob-contact'),email:v('ob-email'),password:pw};
  if(pw.length<12||!/[a-zA-Z]/.test(pw)||!/[0-9]/.test(pw)){ toast('Password: at least 12 characters, with letters and digits','!'); return false; }
  if(pw!==pw2){ toast('The passwords do not match','!'); return false; }
  if(data.legalName.length<2||data.contactName.length<2||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)){ toast('Fill in the institution, your name and a valid work email','!'); return false; }
  if(!(document.getElementById('ob-ack')||{}).checked){ toast('Please confirm you understand this is a sandbox','!'); return false; }
  var base=axBase(); if(!base){ toast('Open this page from the AxLink site to sign up','!'); return false; }
  var btn=document.getElementById('ob-submit'); if(btn){ btn.disabled=true; btn.textContent='Creating your sandbox…'; }
  fetch(base+'/onboarding/sandbox',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(data)})
   .then(function(res){ return res.json().catch(function(){return {};}).then(function(j){ return {ok:res.ok,j:j}; }); })
   .then(function(x){
     if(!x.ok){ var m=(x.j&&x.j.error&&x.j.error.message)||'Signup failed'; toast(liveEsc(m),'!'); if(btn){ btn.disabled=false; btn.innerHTML='Create sandbox account &#8594;'; } return; }
     // Signed in by the HttpOnly cookie the signup set: straight to the dashboard (no key to copy).
     toast('Welcome to AxLink · '+liveEsc(x.j.institution.legalName)); portalEnter();
   })
   .catch(function(){ toast('Network error — try again','!'); if(btn){ btn.disabled=false; btn.innerHTML='Create sandbox account &#8594;'; } });
  return false;
}
function onbCopy(){ var k=ONB._rawKey||''; try{ navigator.clipboard.writeText(k).then(function(){toast('API key copied');}); }catch(e){ var i=document.getElementById('ob-key'); if(i){ i.select(); } } }
function onbOpenDashboard(){ var k=ONB._rawKey; ONB.result=null; ONB._rawKey=null; return connectWithKey(k,''); }
