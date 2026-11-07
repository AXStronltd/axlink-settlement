/**
 * Real end-to-end against a RUNNING AxLink API wired to the Fireblocks sandbox and Solana devnet.
 * Nothing is stubbed: real vaults, a real devnet USDT or USDC deposit (E2E_ASSET), a real vault-to-vault settlement,
 * proof from a Solana node, the operator checks. Run `npm run fb:preflight` first.
 *
 *   E2E_API_URL=https://axlink-settlement.onrender.com E2E_OPS_KEY=… npm run e2e:sandbox
 *
 * Env:
 *   E2E_API_URL        API origin (default http://localhost:4000)
 *   E2E_OPS_KEY        operator key (default OPS_API_KEY)
 *   E2E_ASSET          USDT_SOL (default — AxLink's settlement asset) or USDC_SOL
 *   E2E_DEPOSIT        amount to deposit into Bank A (default 2)
 *   E2E_SETTLE         amount Bank A settles to Bank B (default 1)
 *   E2E_TIMEOUT_MIN    how long to wait for the deposit / settlement each (default 30)
 *
 * The one manual step: the script prints Bank A's deposit address; send EXACTLY E2E_DEPOSIT of the
 * devnet token to it — test USDT: `npm run devnet:usdt -- mint <address> <amount>`; USDC: faucet.circle.com. Bank A's vault also needs devnet SOL for the
 * settlement's network fee: enable the Fireblocks Gas Station for the workspace, or fund the vault's
 * SOL wallet in the console. Exit 0 = every check passed. Never point this at a live workspace.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';

const API = (process.env.E2E_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const OPS = process.env.E2E_OPS_KEY ?? process.env.OPS_API_KEY ?? '';
const ASSET = (process.env.E2E_ASSET ?? 'USDT_SOL') as 'USDT_SOL' | 'USDC_SOL';
const SYM = ASSET.split('_')[0];
const DEPOSIT = process.env.E2E_DEPOSIT ?? '2';
const SETTLE = process.env.E2E_SETTLE ?? '1';
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MIN ?? 30) * 60_000;
const SCOPES = ['wallets:read', 'wallets:write', 'deposits:write', 'deposits:read', 'settlements:read', 'webhooks:write', 'webhooks:read', 'ledger:read', 'counterparties:read', 'counterparties:write', 'transfers:read', 'transfers:write'];

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) { results.push({ name, ok, detail }); console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`); return ok; }
class Abort extends Error {}
function must(name: string, ok: boolean, detail?: string) { if (!check(name, ok, detail)) throw new Abort(name); }

async function call(method: string, path: string, auth: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${auth}`, 'content-type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const text = await r.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
  return { status: r.status, body: json };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | null>, every = 10_000): Promise<T | null> {
  const end = Date.now() + TIMEOUT_MS; let n = 0;
  while (Date.now() < end) { const v = await fn(); if (v) return v; if (++n % 6 === 0) console.log(`    … still waiting for ${what} (${Math.round((end - Date.now()) / 60000)} min left)`); await sleep(every); }
  return null;
}

async function onboard(tag: string) {
  const slug = `e2e-${tag}-${randomUUID().slice(0, 6)}`;
  const inst = await call('POST', '/api/institutions', OPS, { slug, legalName: `E2E Bank ${tag.toUpperCase()}`, country: 'KE', kind: 'BANK' });
  must(`create institution ${tag}`, inst.status === 201, `${inst.status}`);
  const act = await call('POST', `/api/institutions/${inst.body.id}/status`, OPS, { status: 'ACTIVE', reason: 'sandbox end-to-end' });
  must(`activate institution ${tag}`, act.status === 200, `${act.status}`);
  const key = await call('POST', `/api/institutions/${inst.body.id}/credentials`, OPS, { environment: 'SANDBOX', label: 'e2e', scopes: SCOPES });
  must(`issue sandbox key ${tag}`, key.status === 201 && typeof key.body.apiKey === 'string', `${key.status}`);
  const w = await call('POST', '/api/v1/wallets', key.body.apiKey, { label: 'Treasury' });
  must(`wallet ${tag}`, w.status === 201, `${w.status} ${JSON.stringify(w.body?.error ?? '')}`);
  const vault = String(w.body.custody?.vaultId ?? '');
  must(`wallet ${tag} is a real Fireblocks vault`, !!vault && !/^vault_sbx_/.test(vault), `vault ${vault}`);
  return { id: inst.body.id as string, slug, key: key.body.apiKey as string, wallet: w.body, vault };
}
const bal = async (key: string) => (await call('GET', '/api/v1/balances', key)).body?.balances?.find((b: any) => b.asset === ASSET)?.available as string | undefined;

async function main() {
  console.log(`AxLink sandbox end-to-end → ${API}\n`);
  if (!OPS) throw new Error('E2E_OPS_KEY (or OPS_API_KEY) is required');

  console.log('1. Platform');
  const h = await call('GET', '/api/health', '');
  must('health ok', h.status === 200 && h.body?.status === 'ok', JSON.stringify(h.body));
  const ph = await call('GET', '/api/settlement/providers/health', OPS);
  check('custody provider reports configured (not a stub)', ph.status === 200 && !JSON.stringify(ph.body).includes('sandbox stub (no credentials)'), `${ph.status}`);

  // Never onboard on a live deployment: this script creates ACTIVE institutions and real vaults.
  must('target settles on Solana devnet (refusing to onboard on any other network)', h.body?.network === 'solana-devnet', `network=${h.body?.network ?? 'not reported'}`);
  must('target is https (or localhost)', /^https:\/\//.test(API) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API), API);

  console.log('\n2. Onboard Bank A and Bank B (real vaults)');
  const A = await onboard('a'); const B = await onboard('b');
  const me = await call('GET', '/api/v1/institutions/me', A.key);
  check('A sees itself in SANDBOX', me.body?.environment === 'SANDBOX');
  const assets = await call('GET', '/api/v1/assets', A.key);
  const def = assets.body?.assets?.find((a: any) => a.id === ASSET);
  must(`${ASSET} is offered on devnet`, def?.network === 'solana-devnet', JSON.stringify(def ?? null));

  console.log(`\n3. Deposit into Bank A (real devnet ${SYM})`);
  const addr = await call('POST', '/api/v1/custody/deposit-addresses', A.key, { walletId: A.wallet.id, asset: ASSET });
  must('deposit address issued by Fireblocks', addr.status === 200 && !!addr.body.address && !/^sbx_/.test(addr.body.address), addr.body?.address);
  const dep = await call('POST', '/api/v1/deposits', A.key, { walletId: A.wallet.id, asset: ASSET, amount: DEPOSIT, reference: 'E2E-DEP' });
  must('deposit announced', dep.status === 201, `${dep.status}`);
  const how = ASSET === 'USDT_SOL' ? `npm run devnet:usdt -- mint ${addr.body.address} ${DEPOSIT}` : 'faucet.circle.com → USDC → Solana Devnet';
  console.log(`\n    ▶ Send EXACTLY ${DEPOSIT} ${SYM} on Solana DEVNET to:\n\n        ${addr.body.address}\n\n      (${how}). Bank A vault: ${A.vault}\n      Bank A also needs devnet SOL for fees (Gas Station, or fund vault ${A.vault} in the console).\n`);
  const credited = await until('the deposit to be credited', async () => Number(await bal(A.key) ?? 0) === Number(DEPOSIT) ? true : null);
  must(`A credited ${DEPOSIT} ${SYM} (custody webhook received and matched)`, !!credited, `balance ${await bal(A.key)}`);
  const final = await until('on-chain finality of the deposit', async () => { const d = await call('GET', `/api/v1/deposits/${dep.body.id}`, A.key); return d.body?.status === 'COMPLETED' ? d.body : null; });
  check('deposit COMPLETED on a finalized Solana signature', !!final, final ? final.proof?.explorerUrl ?? final.explorerUrl ?? '' : 'not finalized in time');
  const peek = await call('GET', `/api/v1/deposits/${dep.body.id}`, B.key);
  check('Bank B cannot read Bank A\'s deposit', peek.status === 404, `${peek.status}`);

  console.log('\n4. Settle Bank A → Bank B (real vault-to-vault on devnet)');
  const cp = await call('POST', '/api/v1/counterparties', A.key, { label: 'E2E Bank B', participant: B.slug });
  must('B registered as A\'s network counterparty', cp.status === 201, `${cp.status} ${JSON.stringify(cp.body?.error ?? '')}`);
  const idem = `e2e-${randomUUID()}`;
  const s1 = await call('POST', '/api/v1/settlements', A.key, { walletId: A.wallet.id, counterpartyId: cp.body.id, asset: ASSET, amount: SETTLE, reference: 'E2E-NET' }, { 'Idempotency-Key': idem });
  must('settlement accepted', s1.status === 202, `${s1.status} ${JSON.stringify(s1.body?.error ?? '')}`);
  const s2 = await call('POST', '/api/v1/settlements', A.key, { walletId: A.wallet.id, counterpartyId: cp.body.id, asset: ASSET, amount: SETTLE, reference: 'E2E-NET' }, { 'Idempotency-Key': idem });
  check('retry with the same Idempotency-Key returns the same settlement', s2.body?.id === s1.body.id, `${s2.status}`);
  const done = await until('the settlement to finish', async () => { const s = await call('GET', `/api/v1/settlements/${s1.body.id}`, A.key); return ['COMPLETED', 'FAILED'].includes(s.body?.status) ? s.body : null; });
  must('settlement COMPLETED', done?.status === 'COMPLETED', done ? `${done.status} ${done.stage ?? ''}` : 'timed out');
  check('settlement has an on-chain proof', !!done.proof?.txHash, done.proof?.explorerUrl ?? '');
  const left = Number(DEPOSIT) - Number(SETTLE);
  check(`A holds ${left} ${SYM}`, Number(await bal(A.key) ?? NaN) === left, await bal(A.key));
  check(`B received ${SETTLE} ${SYM}`, Number(await bal(B.key) ?? NaN) === Number(SETTLE), await bal(B.key));

  console.log('\n5. Operations');
  const stuck = await call('GET', '/api/settlement/stuck', OPS);
  check('nothing stuck', stuck.body?.count === 0, JSON.stringify(stuck.body?.count));
  const tb = await call('GET', '/api/settlement/books/trial-balance', OPS);
  check('trial balance balanced', tb.body?.balanced === true);
  const rec = await call('POST', '/api/settlement/reconcile', OPS, { kind: 'FULL' });
  check('full reconciliation (ledger vs custody vs chain) has no breaks', rec.status === 200 && rec.body?.breaks === 0, `${rec.body?.status} breaks=${rec.body?.breaks}`);
  const ex = await call('GET', '/api/settlement/exceptions?severity=CRITICAL', OPS);
  const mine = (ex.body?.exceptions ?? []).filter((x: any) => x.institutionId === A.id || x.institutionId === B.id);
  check('no CRITICAL exceptions for A or B', mine.length === 0, mine.map((x: any) => x.kind).join(', '));
}

main()
  .catch(e => { if (!(e instanceof Abort)) check('unexpected error', false, (e as Error).message); })
  .finally(() => {
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.${failed.length ? ` FAILED: ${failed.map(f => f.name).join('; ')}` : ' SANDBOX END-TO-END PASSED.'}`);
    process.exit(failed.length ? 1 : 0);
  });
