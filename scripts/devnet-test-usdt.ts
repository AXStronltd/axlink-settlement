/**
 * AxLink test USDT on Solana DEVNET — Tether publishes no devnet USDT, so the sandbox settles in a
 * 6-decimal SPL token we create. It has no value and exists only on devnet. AxLink treats it as
 * USDT_SOL when SOLANA_DEVNET_USDT_MINT names it (and FIREBLOCKS_USDT_ASSET is its Fireblocks id).
 *
 *   npm run devnet:usdt -- create                       → creates the mint + on-chain name/symbol once, prints SOLANA_DEVNET_USDT_MINT
 *   npm run devnet:usdt -- metadata                     → adds the name/symbol to an existing mint (Fireblocks needs it to register)
 *   npm run devnet:usdt -- mint <ownerAddress> <amount> → issues test USDT to that wallet (e.g. a deposit address)
 *
 * Refuses to run anywhere but devnet (checked by genesis hash). The mint authority keypair is kept in
 * DEVNET_USDT_AUTHORITY (default ~/axlink-settlement/devnet-usdt-authority.key — *.key is git-ignored).
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createCreateMetadataAccountV3Instruction, PROGRAM_ID as METADATA_PROGRAM } from '@metaplex-foundation/mpl-token-metadata';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const RPC = process.env.DEVNET_USDT_RPC ?? 'https://api.devnet.solana.com';
const KEYFILE = process.env.DEVNET_USDT_AUTHORITY ?? join(homedir(), 'axlink-settlement', 'devnet-usdt-authority.key');
const DECIMALS = 6;

function authority(): Keypair {
  if (existsSync(KEYFILE)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYFILE, 'utf8'))));
  const k = Keypair.generate();
  writeFileSync(KEYFILE, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
  console.log(`new devnet mint authority ${k.publicKey.toBase58()} saved to ${KEYFILE}`);
  return k;
}

async function devnet(): Promise<Connection> {
  const c = new Connection(RPC, 'confirmed');
  const g = await c.getGenesisHash();
  if (g !== DEVNET_GENESIS) throw new Error(`refusing: ${RPC} is not Solana devnet (genesis ${g})`);
  return c;
}

async function funded(c: Connection, k: Keypair) {
  const bal = await c.getBalance(k.publicKey);
  if (bal >= 0.05 * LAMPORTS_PER_SOL) return;
  console.log(`requesting a devnet SOL airdrop for ${k.publicKey.toBase58()} (fees)…`);
  try {
    const sig = await c.requestAirdrop(k.publicKey, 1 * LAMPORTS_PER_SOL);
    await c.confirmTransaction(sig, 'confirmed');
  } catch (e) {
    throw new Error(`devnet airdrop failed (${(e as Error).message}). Fund ${k.publicKey.toBase58()} with devnet SOL at https://faucet.solana.com and rerun.`);
  }
}

/** Metaplex metadata (name, symbol) — custodians such as Fireblocks read it to register a token. */
async function addMetadata(c: Connection, k: Keypair, mint: PublicKey) {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mint.toBuffer()], METADATA_PROGRAM);
  if (await c.getAccountInfo(pda)) { console.log(`metadata already present (${pda.toBase58()})`); return; }
  const ix = createCreateMetadataAccountV3Instruction(
    { metadata: pda, mint, mintAuthority: k.publicKey, payer: k.publicKey, updateAuthority: k.publicKey },
    { createMetadataAccountArgsV3: { data: { name: 'AxLink Test USDT', symbol: 'TUSDT', uri: '', sellerFeeBasisPoints: 0, creators: null, collection: null, uses: null }, isMutable: true, collectionDetails: null } },
  );
  const sig = await sendAndConfirmTransaction(c, new Transaction().add(ix), [k]);
  console.log(`metadata added: name "AxLink Test USDT", symbol TUSDT\n  tx https://solscan.io/tx/${sig}?cluster=devnet`);
}

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2);
  const c = await devnet(); const k = authority();
  if (cmd === 'create') {
    if (process.env.SOLANA_DEVNET_USDT_MINT) { console.log(`already configured: SOLANA_DEVNET_USDT_MINT=${process.env.SOLANA_DEVNET_USDT_MINT}`); return; }
    await funded(c, k);
    const mint = await createMint(c, k, k.publicKey, null, DECIMALS);
    await addMetadata(c, k, mint);
    console.log(`\ncreated AxLink test USDT (devnet, ${DECIMALS} decimals)\n  SOLANA_DEVNET_USDT_MINT=${mint.toBase58()}\n\nNext: register it in the Fireblocks sandbox (blockchain SOL_TEST, address above) and set FIREBLOCKS_USDT_ASSET to the id it returns.`);
    return;
  }
  if (cmd === 'metadata') {
    const mintAddr = process.env.SOLANA_DEVNET_USDT_MINT;
    if (!mintAddr) throw new Error('set SOLANA_DEVNET_USDT_MINT');
    await funded(c, k); await addMetadata(c, k, new PublicKey(mintAddr)); return;
  }
  if (cmd === 'mint') {
    const mintAddr = process.env.SOLANA_DEVNET_USDT_MINT;
    if (!mintAddr) throw new Error('set SOLANA_DEVNET_USDT_MINT (npm run devnet:usdt -- create)');
    if (!a1 || !a2 || !(Number(a2) > 0)) throw new Error('usage: mint <ownerAddress> <amount>');
    const amount = BigInt(Math.round(Number(a2) * 10 ** DECIMALS));
    await funded(c, k);
    const ata = await getOrCreateAssociatedTokenAccount(c, k, new PublicKey(mintAddr), new PublicKey(a1));
    const sig = await mintTo(c, k, new PublicKey(mintAddr), ata.address, k, amount);
    console.log(`issued ${a2} test USDT to ${a1} (token account ${ata.address.toBase58()})\n  tx https://solscan.io/tx/${sig}?cluster=devnet`);
    return;
  }
  console.log('usage: npm run devnet:usdt -- create | metadata | mint <ownerAddress> <amount>');
}

main().catch(e => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
