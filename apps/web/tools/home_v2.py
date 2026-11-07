#!/usr/bin/env python3
"""Home v2 — institutional landing page (owner brief 2026-11-07). Re-runnable; fails loudly on a missing anchor.
Run from apps/web:  python3 tools/home_v2.py
- replaces pageHome() with tools/home_v2.js (8 sections; facts only — owner decision: no unverifiable figures)
- adds the .hx-* styles (dark default, 375px-safe, CSS/SVG animation only)
- count-up for numeric stats when they scroll into view
- dark theme by default (the existing toggle still switches to light)
The app (#/app/*), operator console and every other page are untouched."""
import sys, os
here = os.path.dirname(os.path.abspath(__file__))
src = open('index.html', encoding='utf-8').read()

def rep(old, new, marker):
    global src
    if marker in src: return
    if old not in src: sys.exit(f'anchor missing: {old[:80]!r}')
    src = src.replace(old, new, 1)

# 1. pageHome → v2 (replace the whole function, up to the next top-level function)
NEW_HOME = open(os.path.join(here, 'home_v2.js'), encoding='utf-8').read().rstrip() + '\n'
start = src.find('function pageHome(){')
if start < 0: sys.exit('anchor missing: function pageHome(){')
end = src.find('\nfunction ', start + 20)
if end < 0: sys.exit('anchor missing: end of pageHome')
src = src[:start] + NEW_HOME + src[end + 1:]

# 2. dark theme by default
rep('<html lang="en">', '<html lang="en" data-theme="dark">', 'data-theme="dark">')

# 3. count-up when a stat scrolls into view (numbers only; '1:1' and '24/7' stay as they are)
rep("if(x.isIntersecting){x.target.classList.add('in');io.unobserve(x.target);}",
    "if(x.isIntersecting){x.target.classList.add('in');axCountUp(x.target);io.unobserve(x.target);}",
    'axCountUp(x.target)')
rep('function observeReveals(){',
    """function axCountUp(root){
  var els=root.querySelectorAll?root.querySelectorAll('[data-count]'):[];
  Array.prototype.forEach.call(els,function(el){
    var target=el.getAttribute('data-count'); if(!/^\\d+$/.test(target)||el._counted) return; el._counted=true;
    var n=parseInt(target,10), suffix=el.querySelector('span')?el.querySelector('span').outerHTML:'', t0=null;
    if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    function step(ts){ if(!t0) t0=ts; var p=Math.min(1,(ts-t0)/1100), v=Math.round(n*(1-Math.pow(1-p,3)));
      el.innerHTML=v+suffix; if(p<1) requestAnimationFrame(step); }
    requestAnimationFrame(step);
  });
}
function observeReveals(){""", 'function axCountUp(root)')

# 4. styles
CSS = r"""
/* ===== HOME v2 (institutional) ===== */
.hx-hero{position:relative;padding:72px 0 28px;overflow:hidden;background:radial-gradient(70% 60% at 75% 30%,rgba(24,216,234,.10),transparent 70%)}
.hx-hero-grid{display:grid;grid-template-columns:1.05fr .95fr;gap:40px;align-items:center}
.hx-h1{font-size:clamp(34px,5.4vw,60px);font-weight:800;letter-spacing:-.03em;line-height:1.04;margin-top:16px}
.hx-sub{color:var(--ink-2);font-size:clamp(15px,1.6vw,18px);max-width:520px;margin-top:20px;line-height:1.6}
.hx-ctas{display:flex;gap:12px;flex-wrap:wrap;margin-top:30px}
.hx-hero-art{display:flex;justify-content:center}
.hx-map{width:100%;max-width:460px;height:auto;overflow:visible}
.hx-arc{fill:none;stroke:var(--teal);stroke-width:1.4;stroke-dasharray:6 7;opacity:.75;animation:hxflow 2.6s linear infinite}
.hx-pulse{fill:none;stroke:var(--teal);stroke-width:1.5;transform-box:fill-box;transform-origin:center;animation:hxpulse 2.8s ease-out infinite}
@keyframes hxflow{to{stroke-dashoffset:-52}}
@keyframes hxpulse{0%{transform:scale(1);opacity:.8}100%{transform:scale(4);opacity:0}}
.hx-trust{display:flex;flex-wrap:wrap;justify-content:center;gap:10px 28px;margin-top:44px;padding:18px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:13px;color:var(--ink-2);font-weight:500;letter-spacing:.02em}
.hx-trust span{display:inline-flex;align-items:center;gap:8px}
.hx-trust span::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--teal)}
.hx-sec{padding:88px 0}.hx-tight{padding:36px 0 20px}.hx-alt{background:var(--bg-2);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.hx-head{text-align:center;max-width:680px;margin:0 auto 44px}
.hx-head h2,.hx-h2{font-size:clamp(26px,3.6vw,40px);font-weight:800;letter-spacing:-.025em;margin-top:12px}
.hx-head .lead{margin-top:14px}
.hx-stats{display:grid;grid-template-columns:repeat(5,1fr);border:1px solid var(--line);border-radius:16px;background:var(--panel);overflow:hidden}
.hx-stat{padding:26px 20px;border-right:1px solid var(--line)}.hx-stat:last-child{border-right:0}
.hx-stat-num{font-size:34px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.hx-stat-num span{font-size:18px;opacity:.7}
.hx-stat-lbl{font-size:13.5px;font-weight:600;margin-top:6px}.hx-stat-sub{font-size:12px;color:var(--ink-3);margin-top:3px}
.hx-steps{display:flex;align-items:stretch;gap:0}
.hx-step{flex:1;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:28px}
.hx-step-ic{width:46px;height:46px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:var(--teal);background:rgba(24,216,234,.10);border:1px solid var(--line-2)}
.hx-step-n{font-size:11px;letter-spacing:.2em;color:var(--teal);margin-top:18px}
.hx-step h4{font-size:19px;margin-top:6px}.hx-step p{color:var(--ink-2);font-size:14px;margin-top:8px;line-height:1.6}
.hx-link{flex:0 0 46px;display:flex;align-items:center}
.hx-link span{display:block;width:100%;height:2px;background:linear-gradient(90deg,transparent,var(--teal),transparent);background-size:200% 100%;animation:hxslide 2.2s linear infinite}
@keyframes hxslide{from{background-position:100% 0}to{background-position:-100% 0}}
.hx-feat .ic{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:rgba(24,216,234,.10);border:1px solid var(--line-2)}
.hx-feat p{line-height:1.6}
.hx-flow-grid{display:grid;grid-template-columns:.9fr 1.1fr;gap:48px;align-items:start}
.hx-flow{list-style:none;position:relative;padding-left:0}
.hx-flow::before{content:"";position:absolute;left:17px;top:18px;bottom:18px;width:2px;background:linear-gradient(var(--teal),rgba(24,216,234,.1))}
.hx-flow-step{display:flex;gap:16px;align-items:flex-start;padding:12px 0;position:relative}
.hx-flow-step.reveal.in{animation-delay:var(--d)}
.hx-flow-dot{flex:0 0 36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#03231d;background:var(--teal);box-shadow:0 0 0 6px var(--bg),0 0 18px var(--glow);position:relative;z-index:1}
.hx-flow-step h5{font-size:15.5px;font-weight:700}.hx-flow-step p{color:var(--ink-2);font-size:13.5px;margin-top:4px;line-height:1.55}
.hx-code-grid{display:grid;grid-template-columns:.85fr 1.15fr;gap:44px;align-items:center}
.hx-code{background:#07111d;border:1px solid rgba(120,190,225,.18);border-radius:14px;overflow:hidden;box-shadow:0 24px 60px -30px rgba(0,0,0,.7)}
.hx-code-bar{display:flex;align-items:center;gap:7px;padding:11px 14px;border-bottom:1px solid rgba(120,190,225,.12);color:#6b8199;font-size:12px}
.hx-code-bar i{width:10px;height:10px;border-radius:50%;background:#1e3a52;display:inline-block}.hx-code-bar span{margin-left:8px}
.hx-code pre{margin:0;padding:20px;overflow-x:auto;font-family:'SF Mono',ui-monospace,Menlo,monospace;font-size:13px;line-height:1.7;color:#d6e4f0}
.hx-k{color:#c792ea}.hx-s{color:#9be7c4}.hx-c{color:#6b8199}
.hx-scope{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--line);border-radius:16px;overflow:hidden;background:var(--panel)}
.hx-scope>div{padding:28px}.hx-scope>div+div{border-left:1px solid var(--line)}
.hx-scope h4{font-size:15px;letter-spacing:.02em}.hx-scope ul{list-style:none;margin-top:14px}
.hx-scope li{display:flex;gap:12px;align-items:center;padding:9px 0;border-top:1px solid var(--line);font-size:14.5px}
.hx-mark{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0}
.hx-mark.ok{background:rgba(52,211,153,.14);color:var(--green)}.hx-mark.no{background:var(--panel-2);color:var(--ink-3)}
.hx-cta{background:#06101b;color:#eef5fb;text-align:center;padding:96px 0;border-top:1px solid rgba(120,190,225,.14);background-image:radial-gradient(60% 80% at 50% 0%,rgba(24,216,234,.14),transparent 70%)}
.hx-cta h2{font-size:clamp(30px,4.4vw,48px);font-weight:800;letter-spacing:-.025em}
.hx-cta p{color:#a7bcd0;max-width:560px;margin:16px auto 30px;font-size:16.5px;line-height:1.6}
@media(max-width:960px){
  .hx-hero-grid,.hx-flow-grid,.hx-code-grid{grid-template-columns:1fr}
  .hx-hero-art{order:1}.hx-map{max-width:260px}
  .hx-stats{grid-template-columns:1fr 1fr}.hx-stat{border-bottom:1px solid var(--line)}
  .hx-steps{flex-direction:column}.hx-link{flex-basis:28px;justify-content:center}.hx-link span{width:2px;height:100%;min-height:28px;background:linear-gradient(var(--teal),transparent)}
}
@media(max-width:560px){
  .hx-sec{padding:60px 0}.hx-hero{padding:40px 0 20px}
  .hx-stats{grid-template-columns:1fr}.hx-stat{border-right:0}
  .hx-scope{grid-template-columns:1fr}.hx-scope>div+div{border-left:0;border-top:1px solid var(--line)}
  .hx-ctas .btn{flex:1;justify-content:center}
  .hx-code pre{font-size:11.5px;padding:16px}
}
@media(prefers-reduced-motion:reduce){.hx-arc,.hx-pulse,.hx-link span{animation:none}}
"""
rep('</style>', CSS + '</style>', '/* ===== HOME v2 (institutional) ===== */')

open('index.html', 'w', encoding='utf-8').write(src)
print('home v2 applied')
