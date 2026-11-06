import { Router } from 'express';
import * as fs from 'fs'; import * as path from 'path';
/** Serves openapi/openapi.json at /api/openapi.json and a minimal viewer at /api/docs. The spec is a checked-in file, reviewed in PRs. */
export function openapiRouter() {
  const r = Router(); const specPath = path.resolve(process.cwd(), 'openapi', 'openapi.json');
  r.get('/api/openapi.json', (_req, res) => { res.type('application/json').send(fs.readFileSync(specPath, 'utf8')); });
  r.get('/api/docs', (_req, res) => { res.type('html').send(`<!doctype html><title>AxLink API</title><meta charset="utf-8"><style>body{font-family:system-ui;margin:2rem;max-width:60rem}pre{background:#f4f4f4;padding:1rem;overflow:auto}</style><h1>AxLink API</h1><p>OpenAPI document: <a href="/api/openapi.json">/api/openapi.json</a></p><pre id="s">loading…</pre><script>fetch('/api/openapi.json').then(r=>r.json()).then(j=>{document.getElementById('s').textContent=JSON.stringify(j,null,2)})</script>`); });
  return r;
}
