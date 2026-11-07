#!/usr/bin/env python3
"""Self-service sandbox signup in the portal (owner request 2026-11-07). Re-runnable; fails loudly on a missing anchor.
Run from apps/web:  python3 tools/signup_v1.py
Replaces the mock onboarding (fake KYB uploads, 'Sumsub/SEON/Chainalysis', identity-passport NFT, wire funding)
with the real flow: form → POST /v1/onboarding/sandbox → key shown once → Open my dashboard (signs in).
Production access stays operator-only (KYB)."""
import sys, os
here = os.path.dirname(os.path.abspath(__file__))
src = open('index.html', encoding='utf-8').read()
NEW = open(os.path.join(here, 'signup_v1.js'), encoding='utf-8').read().rstrip() + '\n'
if 'function onbSubmit(){' in src:
    # already applied: refresh the block (idempotent re-run picks up edits to signup_v1.js)
    start = src.find('function onboarding(){'); end = src.find('function onbOpenDashboard(')
    end = src.find('\n', end) + 1
else:
    start = src.find('function onboarding(){')
    if start < 0: sys.exit('anchor missing: function onboarding(){')
    end = src.find('\nfunction ', start + 20) + 1
    if end <= 0: sys.exit('anchor missing: end of onboarding()')
src = src[:start] + NEW + src[end:]
open('index.html', 'w', encoding='utf-8').write(src)
print('signup v1 applied')
