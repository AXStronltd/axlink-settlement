## Scope item
<!-- the line in docs/SCOPE.md / the milestone slice this implements -->

## What changed
<!-- files and behaviour, in a few lines; no feature outside the scope item -->

## Commands run (at commit `<hash>`)
```
npx tsc --noEmit
npx vitest run                      # isolated migrated PostgreSQL
SIMULATOR_ENABLED=true npm run simulate
npm run build && (cd apps/web/ops && npm run build)
node scripts/check-web.js && node apps/web/tools/render_check.js
```

## Review (see docs/WORKING-TOGETHER.md)
- [ ] CI green
- [ ] `Codex: review requested at <hash>` posted
- [ ] `No open critical/high at <hash>` posted by Codex
- [ ] Owner approval
- [ ] No deployment, no production data, no live financial transaction
