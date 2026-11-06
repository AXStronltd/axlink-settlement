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

const db = process.env.DATABASE_URL ? describe : describe.skip;

db('portal connected to the API', () => {
  let server: http.Server; let origin: string; let browser: import('playwright').Browser; let apiKey: string; let prisma: any;
  beforeAll(async () => {
    const { app } = await import('../../apps/api/src/index'); ({ prisma } = await import('../../packages/core/ledger/ledger.service'));
    const { seedSandbox } = await import('../../scripts/seed-sandbox');
    const seeded = await seedSandbox({ newKey: true }); apiKey = seeded.apiKey!;
    server = http.createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { chromium } = await import('playwright');
    // The container ships a Chromium at /opt/pw-browsers/chromium (same as apps/web/tools/render_check.js); CI can override.
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
    browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); server?.close(); });

  it('GET /portal serves the AxLink front end; sign-in with the seeded key removes the demo banner and shows the real wallet; actions call the API', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/portal#/signin`);
    await expect(page.title()).resolves.toMatch(/AxLink/);
    await page.fill('#ax-key', apiKey);
    await page.click('button:has-text("Connect")');
    await page.waitForSelector('text=Live · galaxy-bank-so · sandbox', { timeout: 15_000 });
    expect(await page.locator('text=Demonstration — figures are illustrative').count()).toBe(0);

    // Wallet screen shows the seeded wallet from GET /v1/wallets
    await page.evaluate(() => (globalThis as any).go('#/app/treasury'));
    await page.waitForSelector('text=Wallets — GET /v1/wallets');
    expect(await page.locator('td', { hasText: 'Treasury' }).count()).toBeGreaterThan(0);

    // Register a counterparty through the UI → POST /v1/counterparties → ACTIVE (sandbox)
    await page.evaluate(() => (globalThis as any).go('#/app/contacts'));
    await page.click('button:text-is("+ Register counterparty")');
    await page.fill('#lc-label', 'Partner Bank'); await page.fill('#lc-addr', randomUUID().replace(/-/g, '').replace(/[0lIO]/g, 'a').padEnd(44, 'b').slice(0, 44));
    await page.click('.modal button:has-text("Register"), #modal button:has-text("Register"), button:text-is("Register")');
    await page.waitForSelector('text=Partner Bank', { timeout: 10_000 });
    const cps = await prisma.counterparty.findMany({ where: { label: 'Partner Bank' } }); expect(cps.length).toBeGreaterThan(0);

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
    await page.click('button:text-is("+ New settlement")');
    await page.fill('#ls-amount', '5');
    await page.click('button:text-is("Create settlement")');
    await page.waitForSelector('#toast.show');
    expect(await page.locator('#toast').innerText()).toMatch(/available/);
    expect(await prisma.settlementTransfer.count({ where: { reference: 'INV-UI-1' } })).toBe(0);

    // Developers screen shows the real credential; sign-out clears the key
    await page.evaluate(() => (globalThis as any).go('#/app/developers'));
    await page.waitForSelector('text=Who am I');
    expect(await page.locator('pre').first().innerText()).toContain('"slug": "galaxy-bank-so"');
    expect(await page.evaluate(() => sessionStorage.getItem('AX_API_KEY'))).toBe(apiKey);
    await page.evaluate(() => (globalThis as any).signOut());
    expect(await page.evaluate(() => sessionStorage.getItem('AX_API_KEY'))).toBeNull();
    expect(errors).toEqual([]);
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
});
