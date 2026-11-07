const { chromium } = require('playwright');
(async () => {
  const fs = require('fs');
  const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined); // CI path, else Playwright's own install
  const b = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--no-sandbox'] }).catch(e => { console.error('launch', e.message); process.exit(2); });
  const pg = await b.newPage(); const errors = [];
  pg.on('pageerror', e => errors.push('pageerror: ' + e.message)); pg.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await pg.goto('file://' + process.cwd() + '/apps/web/index.html');
  const routes = await pg.evaluate(() => Object.keys(ROUTES));
  const bad = [];
  for (const role of ['client', 'operator']) {
    await pg.evaluate(r => { ROLE = r; }, role);
    for (const r of routes) {
      await pg.evaluate(x => go(x), r);
      const html = await pg.evaluate(() => document.getElementById('app').innerHTML);
      if (html.length < 400 || /Render error/.test(html)) bad.push(role + ' ' + r);
    }
    await pg.evaluate(() => { ENV = 'PRODUCTION'; go('#/app/developers'); go('#/app/treasury'); ENV = 'SANDBOX'; });
  }
  await pg.evaluate(() => go('#/app/developers'));
  await pg.screenshot({ path: 'shot-developers.png', fullPage: false });
  await pg.evaluate(() => go('#/app/treasury'));
  await pg.screenshot({ path: 'shot-wallet.png', fullPage: false });
  await pg.evaluate(() => go('#/'));
  await pg.screenshot({ path: 'shot-home.png', fullPage: false });
  console.log(JSON.stringify({ routes: routes.length, bad, errors: errors.slice(0, 5) }));
  await b.close();
})();
