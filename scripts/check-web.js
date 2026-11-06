// CI guard for apps/web/index.html: inline JS parses, title and route table are intact.
const fs = require('fs'); const s = fs.readFileSync('apps/web/index.html', 'utf8');
const scripts = [...s.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
try { new Function(scripts); } catch (e) { console.error('apps/web/index.html: inline JavaScript does not parse:', e.message); process.exit(1); }
if (!/<title>AxLink — The Open Financial Network<\/title>/.test(s)) { console.error('apps/web/index.html: title changed'); process.exit(1); }
const routes = new Set([...s.matchAll(/'#\/([a-z0-9-]*)'/g)].map(m => m[1]));
for (const r of ['operator', 'onboarding', 'app', 'platform']) if (!routes.has(r)) { console.error(`apps/web/index.html: route #/${r} missing`); process.exit(1); }
console.log(`web ok: ${(s.length / 1024).toFixed(0)} KB, ${routes.size} routes`);
