/**
 * Step 2 · slice 6a — the portal is connected: served by the API at /portal, signed in with a real
 * sandbox API key, every screen renders what /api/v1 returns, and the buttons call the API.
 * Drives a headless Chromium (Playwright, pre-installed) against the Express app on an ephemeral port.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import fs from 'fs';
import { randomUUID } from 'crypto';

process.env.OPS_API_KEY ??= 'test-ops-key-0123456789abcdef';
process.env.API_BASE_URL ??= 'http://localhost:4000/api';
process.env.WEBHOOK_ALLOW_INSECURE_URLS = 'true';

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
let chromiumUsable = !!chromiumPath;
if (!chromiumUsable) { try { require.resolve('playwright'); chromiumUsable = true; } catch { /* no playwright */ } }
if (!chromiumUsable) console.warn('portal.step2: no Chromium/Playwright available — skipping the browser test');
const db = process.env.DATABASE_URL && chromiumUsable ? describe : describe.skip;

db('portal connected to the API', () => {
  let server: http.Server; let origin: string; let browser: import('playwright').Browser; let apiKey: string; let prisma: any; let seededWalletId: string;
  beforeAll(async () => {
    const { app } = await import('../../apps/api/src/index'); ({ prisma } = await import('../../packages/core/ledger/ledger.service'));
    const { seedSandbox } = await import('../../scripts/seed-sandbox');
    const seeded = await seedSandbox({ newKey: true }); apiKey = seeded.apiKey!; seededWalletId = seeded.walletId;
    server = http.createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { chromium } = await import('playwright');
    // The container ships a Chromium at /opt/pw-browsers/chromium (same as apps/web/tools/render_check.js); CI can override.
    browser = await chromium.launch({ executablePath: chromiumPath, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); server?.close(); });

  it('GET /portal serves the AxLink front end; sign-in with the seeded key removes the demo banner and shows the real wallet; actions call the API', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/portal#/signin`);
    await expect(page.title()).resolves.toMatch(/AxLink/);
    await page.fill('#ax-key', apiKey);
    await page.click('button:has-text("Connect")');
    await page.waitForSelector('text=Live · axlink-reference · sandbox', { timeout: 15_000 });
    expect(await page.locator('text=Demonstration — figures are illustrative').count()).toBe(0);

    // Wallet screen shows the seeded wallet from GET /v1/wallets
    await page.evaluate(() => (globalThis as any).go('#/app/treasury'));
    await page.waitForSelector('text=Wallets — GET /v1/wallets');
    // The table header renders at once; the rows arrive with refreshLive() (async) — wait for them, don't race them.
    await page.locator('td', { hasText: 'Treasury' }).first().waitFor({ timeout: 10_000 });
    expect(await page.locator('td', { hasText: 'Treasury' }).count()).toBeGreaterThan(0);

    // Register a counterparty through the UI → POST /v1/counterparties → ACTIVE (sandbox)
    await page.evaluate(() => (globalThis as any).go('#/app/contacts'));
    await page.click('button:text-is("+ Register counterparty")');
    const cpLabel = `Partner <b>${randomUUID().slice(0, 6)}</b>`; // unique per run, and carries markup to prove escaping
    await page.fill('#lc-label', cpLabel); await page.fill('#lc-addr', randomUUID().replace(/-/g, '').replace(/[0lIO]/g, 'a').padEnd(44, 'b').slice(0, 44));
    await page.click('.modal button:has-text("Register"), #modal button:has-text("Register"), button:text-is("Register")');
    await page.waitForSelector(`text=${cpLabel}`, { timeout: 10_000 });
    expect(await prisma.counterparty.count({ where: { label: cpLabel } })).toBe(1);
    expect(await page.locator('td b').count()).toBe(0); // the <b> in the label rendered as text, not as an element

    // Announce a deposit through the UI → POST /v1/deposits → tracking id shown
    await page.evaluate(() => (globalThis as any).go('#/app/treasury'));
    await page.click('button:text-is("Announce a deposit")');
    await page.fill('#ld-amount', '12.5'); await page.fill('#ld-ref', 'INV-UI-1');
    await page.click('button:text-is("Create instruction")');
    await page.waitForSelector('text=Deposit instruction created', { timeout: 10_000 });
    const tracking = await page.locator('b.mono').first().innerText(); expect(tracking).toMatch(/^dep_/);
    await page.click('text=Done');
    await page.waitForSelector(`text=${tracking}`);

    // Settlement from the UI with an insufficient balance → the API's error is surfaced, nothing created
    await page.evaluate(() => (globalThis as any).go('#/app/payments'));
    const transfersBefore = await prisma.settlementTransfer.count({ where: { walletId: seededWalletId } });
    await page.click('button:text-is("+ New settlement")');
    await page.fill('#ls-amount', '5');
    await page.click('button:text-is("Create settlement")');
    await page.waitForFunction(() => /available/.test((globalThis as any).document.getElementById('toast')?.textContent ?? ''), null, { timeout: 10_000 });
    expect(await prisma.settlementTransfer.count({ where: { walletId: seededWalletId } })).toBe(transfersBefore);

    // Transactions = the ledger statement; Balances = journal-derived; screens without an API are not in the live nav
    await page.evaluate(() => (globalThis as any).go('#/app/transactions')); await page.waitForSelector('text=GET /v1/ledger/entries');
    await page.evaluate(() => (globalThis as any).go('#/app/balances')); await page.waitForSelector('text=GET /v1/balances');
    expect(await page.locator('nav a:has-text("Compliance")').count()).toBe(0);
    expect(await page.locator('nav a:has-text("Balances")').count()).toBe(1);

    // Developers screen shows the real credential; sign-out clears the key
    await page.evaluate(() => (globalThis as any).go('#/app/developers'));
    await page.waitForSelector('text=Who am I');
    expect(await page.locator('pre').first().innerText()).toContain('"slug": "axlink-reference"');
    expect(await page.evaluate(() => sessionStorage.getItem('AX_API_KEY'))).toBe(apiKey);
    await page.evaluate(() => (globalThis as any).signOut());
    expect(await page.evaluate(() => sessionStorage.getItem('AX_API_KEY'))).toBeNull();
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it('operator console: the operator key opens the exception queue; an exception can be acknowledged and resolved from the UI; the key clears on sign-out', async () => {
    const ex = await import('../../packages/settlement/operations/exception.service');
    const { Prisma } = await import('@prisma/client');
    const subject = `CUSTODY:vault_ui_${randomUUID().slice(0, 8)}:USDC_SOL`;
    const raised = await ex.raiseException({ kind: 'CUSTODY_MISMATCH', severity: 'CRITICAL', subject, currency: 'USDC_SOL', expected: new Prisma.Decimal(5), actual: new Prisma.Decimal(4) });
    const page = await browser.newPage();
    await page.goto(`${origin}/portal#/signin`);
    await page.click('text=Operator sign-in');
    await page.fill('#ax-ops', process.env.OPS_API_KEY!);
    await page.click('button:has-text("Connect operator console")');
    await page.waitForSelector('text=Operator console · live', { timeout: 15_000 });
    await page.waitForSelector(`[title="${subject}"]`, { timeout: 10_000 });
    expect(await page.evaluate(() => sessionStorage.getItem('AX_OPS_KEY'))).toBe(process.env.OPS_API_KEY);
    const row = page.locator('tr', { has: page.locator(`[title="${subject}"]`) });
    await row.locator('button:text-is("Acknowledge")').click();
    await page.waitForFunction((id: string) => !!(globalThis as any).OPS.exceptions?.find((x: any) => x.id === id && x.status === 'ACKNOWLEDGED'), raised.id, { timeout: 10_000 });
    await row.locator('button:text-is("Resolve")').click();
    await page.fill('#ox-note', 'checked with custodian; hold released');
    await page.click('.modal button:text-is("Resolve")');
    await page.waitForFunction((id: string) => !(globalThis as any).OPS.exceptions?.find((x: any) => x.id === id), raised.id, { timeout: 10_000 });
    const after = await prisma.operationalException.findUnique({ where: { id: raised.id } });
    expect(after).toMatchObject({ status: 'RESOLVED', resolution: 'checked with custodian; hold released', resolvedBy: 'operator' });
    // Approvals and Providers answer live too
    await page.evaluate(() => (globalThis as any).go('#/app/approvals')); await page.waitForSelector('text=GET /api/settlement/transfers/pending');
    await page.evaluate(() => (globalThis as any).go('#/app/providers')); await page.waitForSelector('text=sandbox stub');
    await page.evaluate(() => (globalThis as any).signOut());
    expect(await page.evaluate(() => sessionStorage.getItem('AX_OPS_KEY'))).toBeNull();
    await page.close();
  }, 60_000);

  it('a wrong key never connects and leaves nothing behind', async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/portal#/signin`);
    await page.fill('#ax-key', 'axlk_test_wrongwrongwrongwrongwrong');
    await page.click('button:has-text("Connect")');
    await page.waitForSelector('#toast.show');
    expect(await page.locator('#toast').innerText()).toMatch(/Could not connect/);
    expect(await page.evaluate(() => sessionStorage.getItem('AX_API_KEY'))).toBeNull();
    expect(await page.locator('text=Live ·').count()).toBe(0);
    await page.close();
  }, 30_000);

  it('a bank signs itself up for the sandbox in the browser, sees its key once and lands in its dashboard', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/portal#/onboarding`);
    await page.fill('#ob-name', 'Browser Test Bank');
    await page.selectOption('#ob-kind', 'BANK'); await page.selectOption('#ob-country', 'KE');
    await page.fill('#ob-contact', 'Amina Tester'); await page.fill('#ob-email', `tester-${randomUUID().slice(0, 8)}@bank.example`);
    await page.check('#ob-ack');
    await page.click('#ob-submit');
    await page.waitForSelector('text=is on the sandbox', { timeout: 15_000 });
    const key = await page.inputValue('#ob-key');
    expect(key).toMatch(/^axlk_test_/);
    await page.click('button:has-text("Open my dashboard")');
    await page.waitForSelector('text=Live · browser-test-bank-', { timeout: 15_000 });
    await page.evaluate(() => (globalThis as any).go('#/app/treasury'));
    await page.click('button:has-text("+ New wallet")');
    await page.fill('#lw-label', 'Treasury'); await page.click('.modal button:has-text("Create")');
    await page.locator('td', { hasText: 'Treasury' }).first().waitFor({ timeout: 15_000 });
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});
