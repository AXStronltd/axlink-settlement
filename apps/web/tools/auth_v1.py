#!/usr/bin/env python3
"""Portal sign-in for people (owner request 2026-11-07): email + password → HttpOnly session cookie.
Users never paste an API key into the browser; keys are created in Developers → API keys for the bank's servers.
Re-runnable; fails loudly on a missing anchor.  Run from apps/web:  python3 tools/auth_v1.py"""
import sys
src = open('index.html', encoding='utf-8').read()

def rep(old, new, marker):
    global src
    if marker in src: return
    if old not in src: sys.exit(f'anchor missing: {old[:90]!r}')
    src = src.replace(old, new, 1)

def replace_fn(name, new, marker):
    """Replace a whole top-level function `function name(...){...}` up to the next top-level function."""
    global src
    if marker in src: return
    start = src.find('function ' + name + '(')
    if start < 0: sys.exit(f'anchor missing: function {name}(')
    end = src.find('\nfunction ', start + 10)
    if end < 0: sys.exit(f'anchor missing: end of {name}')
    src = src[:start] + new.rstrip() + '\n' + src[end + 1:]

# 1. API calls: a stored key (servers/dev tools) still works; otherwise the session cookie + the portal CSRF header.
rep("""  var h={'Authorization':'Bearer '+axKey()}; if(body) h['Content-Type']='application/json'; if(headers) for(var k in headers) h[k]=headers[k];
  return fetch(base+path,{method:method,headers:h,body:body?JSON.stringify(body):undefined}).then(function(r){""",
"""  var k0=axKey(); var h=k0?{'Authorization':'Bearer '+k0}:{'X-AxLink-Portal':'1'}; if(body) h['Content-Type']='application/json'; if(headers) for(var k in headers) h[k]=headers[k];
  return fetch(base+path,{method:method,headers:h,credentials:'same-origin',body:body?JSON.stringify(body):undefined}).then(function(r){""",
"var k0=axKey(); var h=k0?")

# 2. Sign-in page: email + password (no key field). Operator console sign-in unchanged.
replace_fn('pageSignIn', r"""function pageSignIn(){
  /* auth_v1: people sign in with email + password; the session is an HttpOnly cookie. */
  return siteHeader('')+'<div class="site-body">'+
   '<section style="padding:60px 0 100px;min-height:72vh;display:flex;align-items:center"><div class="wrap" style="max-width:440px;margin:0 auto"><div class="reveal" style="text-align:center;margin-bottom:26px">'+markSized(40)+'<h1 style="font-size:28px;margin-top:14px">Sign in to AxLink</h1><p class="lead" style="font-size:14px;margin-top:6px">Institution portal: your wallets, deposits and settlements.</p></div>'+
   '<form class="panel reveal d1" style="padding:28px" onsubmit="return portalSignIn()">'+
   '<div class="field"><label for="si-email">Work email</label><input id="si-email" type="email" autocomplete="username" placeholder="you@institution.com" required/></div>'+
   '<div class="field"><label for="si-pass">Password</label><input id="si-pass" type="password" autocomplete="current-password" required/></div>'+
   '<button id="si-btn" type="submit" class="btn btn-primary" style="width:100%;justify-content:center;margin-top:4px">Sign in</button>'+
   '<div style="text-align:center;margin-top:14px;font-size:12.5px;color:var(--ink-3)">Two-factor authentication is required for production access.</div>'+
   '<div style="text-align:center;margin-top:14px;padding-top:14px;border-top:1px solid var(--line);font-size:11.5px;color:var(--ink-3)">AxLink staff? <span style="color:var(--ink-2);cursor:pointer;font-weight:600" onclick="document.getElementById(\'ops-box\').style.display=\'\'">Operator sign-in</span></div>'+
   '<div id="ops-box" style="display:none;margin-top:10px"><div class="field"><label>Operator key</label><input id="ax-ops" type="password" placeholder="OPS_API_KEY" autocomplete="off"/></div><button type="button" class="btn btn-ghost" style="width:100%;justify-content:center" onclick="return connectAsOperator(document.getElementById(\'ax-ops\').value)">Connect operator console</button></div>'+
   '</form>'+
   '<p class="reveal d2" style="text-align:center;color:var(--ink-3);font-size:13px;margin-top:22px">New institution? <a href="javascript:void(0)" onclick="return go(\'#/onboarding\')" style="color:var(--teal);font-weight:600">Create a sandbox account &#8594;</a></p>'+
   '</div></section>'+siteFooter();
}
function portalSignIn(){
  var email=(document.getElementById('si-email')||{}).value||'', pass=(document.getElementById('si-pass')||{}).value||'';
  var base=axBase(); if(!base){ toast('Open this page from the AxLink site to sign in','!'); return false; }
  var btn=document.getElementById('si-btn'); if(btn){ btn.disabled=true; btn.textContent='Signing in…'; }
  fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({email:email.trim(),password:pass})})
   .then(function(r){ return r.json().catch(function(){return {};}).then(function(j){ if(!r.ok) throw new Error((j.error&&j.error.message)||'Sign-in failed'); }); })
   .then(function(){ return portalEnter(); })
   .catch(function(e){ toast(liveEsc(e.message),'!'); if(btn){ btn.disabled=false; btn.textContent='Sign in'; } });
  return false;
}
/* Signed in (cookie): load the institution and open its dashboard. */
function portalEnter(){
  try{ sessionStorage.removeItem('AX_API_KEY'); }catch(e){}
  return axApi('GET','/institutions/me').then(function(me){ LIVE.me=me; LIVE.error=null; ROLE='client'; ENV=me.environment; toast('Signed in · '+liveUnesc(me.institution.slug)); go('#/app'); refreshLive(); });
}""", 'function portalSignIn(){')

# 3. Restore a signed-in session on reload (cookie), as well as the old per-tab key.
rep("""(function(){ if(axKey()&&axBase()){ axApi('GET','/institutions/me')""",
"""(function(){ if(!axKey()&&axBase()&&location.protocol.indexOf('http')===0){ fetch(axBase()+'/auth/session',{credentials:'same-origin'}).then(function(r){ if(r.ok) return axApi('GET','/institutions/me').then(function(me){ LIVE.me=me; ROLE='client'; ENV=me.environment; if(CURRENT.indexOf('#/app')!==0&&CURRENT!=='#/'&&CURRENT!=='') CURRENT='#/app'; render(); refreshLive(); }); }).catch(function(){}); } })();
(function(){ if(axKey()&&axBase()){ axApi('GET','/institutions/me')""",
"fetch(axBase()+'/auth/session'")

# 4. Sign out ends the server session too.
rep("function signOut(){ var wasOp=(ROLE==='operator'); disconnectLive();",
    "function signOut(){ var wasOp=(ROLE==='operator'); if(!wasOp&&axBase()){ fetch(axBase()+'/auth/logout',{method:'POST',credentials:'same-origin'}).catch(function(){}); } disconnectLive();",
    "fetch(axBase()+'/auth/logout'")

# 5. Developers → API keys (for the bank's servers): list, create (shown once), revoke.
rep("""function liveDevelopers(){
  var me=LIVE.me; var base=axBase();
  var code='GET '+base+'/institutions/me\\nAuthorization: Bearer '+axKey().slice(0,14)+'…\\n\\n200 OK\\n'+JSON.stringify(me,null,2);""",
"""function liveDevelopers(){
  var me=LIVE.me; var base=axBase();
  if(!LIVE.keys){ LIVE.keys=[]; axApi('GET','/portal/credentials').then(function(k){ LIVE.keys=k; if(CURRENT==='#/app/developers') render(); }).catch(function(){}); }
  var code='GET '+base+'/institutions/me\\nAuthorization: Bearer axlk_test_…\\n\\n200 OK\\n'+JSON.stringify(me,null,2);""",
"LIVE.keys=[]; axApi('GET','/portal/credentials')")
rep("""  return appShell('#/app/developers', liveHead()+pageHead('Developers',""",
"""  var keyRows=(LIVE.keys||[]).map(function(k){ return '<tr><td style="font-weight:500">'+k.label+'</td><td class="mono" style="font-size:12px;color:var(--teal)">'+k.prefix+'…</td><td style="color:var(--ink-3)">'+liveWhen(k.createdAt)+'</td><td style="color:var(--ink-3)">'+(k.lastUsedAt?liveWhen(k.lastUsedAt):'never')+'</td><td>'+(k.revokedAt?'<span class="badge badge-failed">Revoked</span>':'<button class="btn btn-ghost btn-sm" onclick="portalRevokeKey(\\''+k.id+'\\')">Revoke</button>')+'</td></tr>'; }).join('')||'<tr><td colspan="5" style="color:var(--ink-3)">No API keys yet. Create one for your core-banking or treasury server.</td></tr>';
  var keysCard='<div class="chart-card reveal" style="margin-bottom:14px"><div class="ch"><h4>API keys for your servers</h4><button class="btn btn-primary btn-sm" onclick="portalCreateKey()">+ Create API key</button></div><p style="color:var(--ink-3);font-size:12.5px;margin-bottom:10px">People sign in with email and password; your backend uses an API key (Bearer). A key is shown once when created. Sandbox keys start with axlk_test_.</p><table><thead><tr><th>Label</th><th>Prefix</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>'+keyRows+'</tbody></table></div>';
  return appShell('#/app/developers', liveHead()+keysCard+pageHead('Developers',""",
"var keysCard=")
rep("function liveAmt(a){",
"""function portalCreateKey(){
  openModal('<h3 style="font-size:19px;margin-bottom:14px">Create API key</h3><div class="field"><label for="pk-label">Label</label><input id="pk-label" maxlength="80" placeholder="e.g. Core banking server"/></div><button class="btn btn-primary" style="width:100%;justify-content:center" onclick="portalDoCreateKey()">Create</button>');
}
function portalDoCreateKey(){
  var label=((document.getElementById('pk-label')||{}).value||'').trim(); if(!label){ toast('Give the key a label','!'); return; }
  axApi('POST','/portal/credentials',{label:label}).then(function(k){
    LIVE.keys=null;
    openModal('<h3 style="font-size:19px;margin-bottom:8px">Your new API key</h3><p style="color:var(--ink-3);font-size:13px;margin-bottom:14px">Shown once. Store it in your server&#39;s secret manager; AxLink keeps only a hash.</p><div style="display:flex;gap:8px"><input id="pk-key" class="mono" readonly value="'+k.apiKey+'" style="font-size:12.5px"/><button class="btn btn-ghost btn-sm" onclick="var i=document.getElementById(\\'pk-key\\');i.select();try{navigator.clipboard.writeText(i.value);toast(\\'Copied\\');}catch(e){}">Copy</button></div><button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:16px" onclick="closeModal();render()">Done</button>');
  }).catch(function(e){ toast(e.message,'!'); });
}
function portalRevokeKey(id){ axApi('POST','/portal/credentials/'+encodeURIComponent(id)+'/revoke',{}).then(function(){ LIVE.keys=null; toast('Key revoked'); render(); }).catch(function(e){ toast(e.message,'!'); }); }
function liveAmt(a){""",
"function portalCreateKey(){")

open('index.html', 'w', encoding='utf-8').write(src)
print('auth v1 applied')
