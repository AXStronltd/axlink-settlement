/**
 * Fireblocks + Solana preflight — run before the sandbox end-to-end and before go-live.
 *
 *   npm run fb:preflight
 *
 * Read-only. It never creates a vault, an address or a transaction. It answers:
 *   1. Do FIREBLOCKS_API_KEY + the signing key authenticate against FIREBLOCKS_BASE_URL / the default host?
 *   2. Which asset ids does THIS workspace use for SOL and for USDC on the configured cluster?
 *      (Testnet ids are workspace-specific; on devnet FIREBLOCKS_USDC_ASSET must be set to one of them.)
 *   3. Is SOLANA_RPC_URL really the cluster SOLANA_CLUSTER says (by genesis hash), and is it a dedicated node?
 *   4. Do workspace and cluster agree (sandbox ⇔ devnet, live ⇔ mainnet)?
 * Exit code 0 = ready, 1 = something to fix (each problem printed). Secrets are never printed.
 */
import 'dotenv/config';
import { listVaultAccounts, getSupportedAssets, isConfigured, fireblocksBasePath } from '../packages/providers/custody/fireblocks/fireblocks';
import { MINTS, solanaCluster, ASSETS } from '../packages/core/assets/registry';

const GENESIS: Record<string, 'mainnet' | 'devnet' | 'testnet'> = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet',
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG': 'devnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
};

const problems: string[] = [];
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => { problems.push(m); console.log(`  ✗ ${m}`); };
const info = (m: string) => console.log(`    ${m}`);

async function rpc(url: string, method: string, params: unknown[] = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  const j = await r.json() as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function main() {
  const cluster = solanaCluster();
  const fbSandbox = process.env.FIREBLOCKS_SANDBOX === 'true';
  console.log(`AxLink preflight — SOLANA_CLUSTER=${cluster}, FIREBLOCKS_SANDBOX=${fbSandbox}`);

  // ── 4. agreement ──
  console.log('\nWorkspace ⇔ cluster');
  if (fbSandbox === (cluster === 'devnet')) ok(fbSandbox ? 'sandbox workspace on devnet' : 'live workspace on mainnet');
  else bad(fbSandbox ? 'FIREBLOCKS_SANDBOX=true needs SOLANA_CLUSTER=devnet' : 'SOLANA_CLUSTER=devnet needs FIREBLOCKS_SANDBOX=true');

  // ── 3. Solana node ──
  console.log('\nSolana RPC');
  const url = process.env.SOLANA_RPC_URL;
  if (!url) bad('SOLANA_RPC_URL is not set');
  else {
    const host = (() => { try { return new URL(url).host; } catch { return '(invalid URL)'; } })();
    info(`host: ${host}`);
    if (/^api\.(mainnet-beta|devnet|testnet)\.solana\.com$/.test(host)) bad('public Solana endpoint: use a dedicated node (it rate-limits finality checks)');
    try {
      const g = String(await rpc(url, 'getGenesisHash'));
      const real = GENESIS[g] ?? 'unknown';
      if (real === cluster) ok(`node is ${real} (genesis ${g.slice(0, 8)}…)`);
      else bad(`node is ${real}, but SOLANA_CLUSTER=${cluster}`);
      const slot = await rpc(url, 'getSlot', [{ commitment: 'finalized' }]);
      ok(`finalized slot ${slot}`);
    } catch (e) { bad(`RPC call failed: ${(e as Error).message}`); }
  }

  // ── 1. Fireblocks auth ──
  console.log('\nFireblocks');
  if (!isConfigured()) { bad('FIREBLOCKS_API_KEY / FIREBLOCKS_SECRET_KEY_PATH not set (or placeholder)'); return; }
  let base = '?';
  try { base = fireblocksBasePath(fbSandbox); } catch (e) { bad((e as Error).message); return; }
  info(`API host: ${base}`);
  try {
    const v = await listVaultAccounts(5) as { accounts?: { id: string; name: string }[] };
    ok(`authenticated — ${v.accounts?.length ?? 0} vault(s) visible on the first page`);
    for (const a of v.accounts ?? []) info(`vault ${a.id}: ${a.name}`);
  } catch (e) {
    const m = (e as { response?: { status?: number }; message?: string });
    bad(`authentication failed (${m.response?.status ?? ''} ${m.message ?? ''}).`);
    info('If this is a testnet/developer workspace rather than the legacy sandbox, set FIREBLOCKS_BASE_URL=https://api.fireblocks.io/v1 and rerun.');
    info('Also check the API user is bound to this key pair and is not disabled.');
    return;
  }

  // ── 2. asset ids ──
  console.log('\nAsset ids in this workspace');
  let assets: { id: string; name?: string; type?: string; contractAddress?: string; nativeAsset?: string; decimals?: number }[] = [];
  try { assets = (await getSupportedAssets()) as typeof assets; } catch (e) { bad(`supported assets: ${(e as Error).message}`); return; }
  const want = MINTS[cluster];
  const solNative = assets.filter(a => a.type === 'BASE_ASSET' && /^SOL/.test(a.id) && (cluster === 'devnet' ? /TEST|DEV/i.test(a.id) : a.id === 'SOL'));
  if (solNative.length) ok(`native SOL (fees): ${solNative.map(a => a.id).join(', ')}`); else bad(`no native SOL asset for ${cluster} found — vaults cannot pay fees`);
  for (const id of ['USDC_SOL', 'USDT_SOL'] as const) {
    const mint = want[id];
    if (!mint) { info(`${id}: not supported on ${cluster} (no public mint) — skipped`); continue; }
    const hits = assets.filter(a => a.contractAddress === mint);
    const configured = ASSETS[id].providerIds.fireblocks;
    if (!hits.length) { (id === 'USDC_SOL' ? bad : info)(`${id}: no Fireblocks asset with mint ${mint} in this workspace`); continue; }
    ok(`${id} (mint ${mint.slice(0, 6)}…) → Fireblocks id ${hits.map(h => h.id).join(' or ')}`);
    if (configured && hits.some(h => h.id === configured)) ok(`${id}: configured id ${configured} matches`);
    else bad(`${id}: set ${id === 'USDC_SOL' ? 'FIREBLOCKS_USDC_ASSET' : 'FIREBLOCKS_USDT_ASSET'}=${hits[0].id} (currently ${configured ?? 'unset'})`);
  }

  // ── webhook verification ──
  console.log('\nWebhooks');
  // Only JWKS-signed webhooks (Fireblocks-Webhook-Signature) are sent since 2026-03-20.
  const jwks = process.env.FIREBLOCKS_WEBHOOK_JWKS_URL;
  const wantJwks = fbSandbox ? 'https://sandbox-keys.fireblocks.io/.well-known/jwks.json' : 'https://keys.fireblocks.io/.well-known/jwks.json (or eu-/eu2-keys for EU workspaces)';
  if (!jwks) bad(`FIREBLOCKS_WEBHOOK_JWKS_URL not set — set it to ${wantJwks}; without it no webhook verifies and no deposit is credited`);
  else if (fbSandbox !== jwks.startsWith('https://sandbox-keys.')) bad(`FIREBLOCKS_WEBHOOK_JWKS_URL ${jwks} does not match this workspace; expected ${wantJwks}`);
  else {
    try {
      const r = await fetch(jwks, { signal: AbortSignal.timeout(10_000) }); const j = await r.json() as { keys?: { kid?: string; alg?: string }[] };
      const rs = (j.keys ?? []).filter(k => k.alg === 'RS512');
      if (rs.length) ok(`JWKS reachable — ${rs.length} RS512 key(s): ${rs.map(k => k.kid).join(', ')}`); else bad(`JWKS at ${jwks} has no RS512 keys`);
    } catch (e) { bad(`JWKS fetch failed: ${(e as Error).message}`); }
  }
  info('Fireblocks console → Developer Center → Webhooks: subscribe to transaction.status.updated (and transaction.created).');
  info(`Fireblocks console → Webhooks must POST to ${(process.env.API_BASE_URL ?? '<API_BASE_URL>').replace(/\/$/, '')}/webhooks/fireblocks`);
}

main()
  .catch(e => { bad(`unexpected: ${(e as Error).message}`); })
  .finally(() => {
    console.log(problems.length ? `\nNOT READY — ${problems.length} problem(s).` : '\nREADY.');
    process.exit(problems.length ? 1 : 0);
  });
