/**
 * Environment configuration, validated once at boot.
 *
 * Two tiers: `required` stops the process when missing; `provider` credentials
 * are optional and their absence means "sandbox mode" for that provider (the
 * existing behaviour — stubs stay in place). Nothing here reads process.env
 * lazily: every module that needs a value takes it from `config()`.
 */
import { z } from 'zod';

const bool = z.enum(['true', 'false']).default('false').transform(v => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production', 'demo']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url().refine(u => /^postgres(ql)?:\/\//.test(u), 'DATABASE_URL must be a postgres:// URL'),
  API_BASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  OPS_API_KEY: z.string().min(16).optional(),
  SIMULATOR_ENABLED: bool,
  ALLOW_UNVERIFIED_WEBHOOKS: bool, // F2: local dev only; refused in production
  FIREBLOCKS_WORKSPACE_ID: z.string().optional(),
  FIREBLOCKS_WEBHOOK_JWKS_URL: z.enum(['https://keys.fireblocks.io/.well-known/jwks.json', 'https://eu-keys.fireblocks.io/.well-known/jwks.json', 'https://eu2-keys.fireblocks.io/.well-known/jwks.json', 'https://sandbox-keys.fireblocks.io/.well-known/jwks.json']).optional(),
  FIREBLOCKS_WEBHOOK_PUBLIC_KEY: z.string().optional(), B2BINPAY_CALLBACK_SECRET: z.string().optional(),
  WEBHOOK_ENCRYPTION_KEY: z.string().optional(), // Step 2: AES-256-GCM key for institution webhook secrets
  WEBHOOK_ALLOW_INSECURE_URLS: bool, // Step 2: tests only — http and private hosts for institution webhooks
  DEMO_ENABLED: bool,
  SETTLEMENT_WORKER_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  OUTBOX_WORKER_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  // Provider credentials — optional; unset = stubbed (sandbox mode).
  FIREBLOCKS_API_KEY: z.string().optional(), FIREBLOCKS_TREASURY_VAULT: z.string().optional(),
  B2BINPAY_CLIENT_ID: z.string().optional(), B2BINPAY_CLIENT_SECRET: z.string().optional(),
  BRAINROCK_API_KEY: z.string().optional(), BRAINROCK_TREASURY_ACCOUNT_ID: z.string().optional(),
  CHOICE_BANK_API_KEY: z.string().optional(), DARAJA_CONSUMER_KEY: z.string().optional(), DARAJA_CONSUMER_SECRET: z.string().optional(),
  SOLANA_RPC_URL: z.string().url().optional(),
  // One cluster per deployment. devnet = Fireblocks sandbox/testnet workspace + Circle devnet USDC; mainnet = live.
  SOLANA_CLUSTER: z.enum(['mainnet', 'devnet']).default('mainnet'),
  FIREBLOCKS_SANDBOX: z.string().optional(),
  FIREBLOCKS_USDC_ASSET: z.string().optional(), FIREBLOCKS_USDT_ASSET: z.string().optional(),
  OUTBOUND_SETTLEMENT_ENABLED: z.string().optional(),
  SCREENING_OPTIONAL: z.string().optional(),
  TRANSFER_MAX_AMOUNT: z.string().optional(),
  TRANSFER_DAILY_LIMIT: z.string().optional(),
  TRANSFER_MAX_PER_HOUR: z.string().optional(),
});
export type AppConfig = z.infer<typeof schema>;

const PLACEHOLDER = /^(your_|YOUR_|changeme|xxx)/;
const PROVIDER_KEYS: (keyof AppConfig)[] = ['FIREBLOCKS_API_KEY', 'FIREBLOCKS_TREASURY_VAULT', 'B2BINPAY_CLIENT_ID', 'B2BINPAY_CLIENT_SECRET', 'BRAINROCK_API_KEY', 'BRAINROCK_TREASURY_ACCOUNT_ID', 'CHOICE_BANK_API_KEY', 'DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET'];

export interface ConfigReport { config: AppConfig; sandboxProviders: string[]; }

/** Parse and validate. Throws a ConfigError listing every problem at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigReport {
  const r = schema.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(lines);
  }
  const cfg = r.data;
  if (cfg.NODE_ENV === 'production' || cfg.NODE_ENV === 'demo') {
    if (cfg.NODE_ENV === 'demo') {
      // Demo mode: all providers stubbed, no real credentials required.
      // Switch NODE_ENV=production and wire credentials to go live.
      const sandboxProviders2 = PROVIDER_KEYS.filter(k => { const v = cfg[k]; return !v || PLACEHOLDER.test(String(v)); }).map(String);
      return { config: cfg, sandboxProviders: sandboxProviders2 };
    }
    const prodProblems: string[] = [];
    if (!cfg.FIREBLOCKS_WORKSPACE_ID || PLACEHOLDER.test(cfg.FIREBLOCKS_WORKSPACE_ID)) prodProblems.push('FIREBLOCKS_WORKSPACE_ID is required in production');
    if (!cfg.OPS_API_KEY) prodProblems.push('OPS_API_KEY is required in production');
    if (cfg.SIMULATOR_ENABLED) prodProblems.push('SIMULATOR_ENABLED must be false in production');
    if (cfg.DEMO_ENABLED) prodProblems.push('DEMO_ENABLED must be false in production');
    if (cfg.ALLOW_UNVERIFIED_WEBHOOKS) prodProblems.push('ALLOW_UNVERIFIED_WEBHOOKS must be false in production');
    if (!cfg.WEBHOOK_ENCRYPTION_KEY || PLACEHOLDER.test(cfg.WEBHOOK_ENCRYPTION_KEY)) prodProblems.push('WEBHOOK_ENCRYPTION_KEY is required in production');
    if (cfg.WEBHOOK_ALLOW_INSECURE_URLS) prodProblems.push('WEBHOOK_ALLOW_INSECURE_URLS must be false in production');
    // F2: a crypto-settlement webhook that cannot be verified is refused at runtime (503); in production
    // that is an outage, so the keys are required at boot.
    // Fireblocks stopped sending the legacy static-key `Fireblocks-Signature` header on 2026-03-20; only the
    // JWKS-signed `Fireblocks-Webhook-Signature` arrives. A static key alone would reject every webhook, so
    // deposits would silently never credit. Production must verify against the workspace's JWKS.
    if (!cfg.FIREBLOCKS_WEBHOOK_JWKS_URL) prodProblems.push('FIREBLOCKS_WEBHOOK_JWKS_URL is required in production (FIREBLOCKS_WEBHOOK_PUBLIC_KEY is required in production only for the retired legacy header and no longer suffices)');
    // The legacy sandbox (sandbox-api host) signs with sandbox-keys; a live workspace never does. A testnet
    // workspace served from an overridden FIREBLOCKS_BASE_URL is checked by `npm run fb:preflight` instead.
    else if (!process.env.FIREBLOCKS_BASE_URL && (cfg.FIREBLOCKS_SANDBOX === 'true') !== cfg.FIREBLOCKS_WEBHOOK_JWKS_URL.startsWith('https://sandbox-keys.')) prodProblems.push(`FIREBLOCKS_WEBHOOK_JWKS_URL ${cfg.FIREBLOCKS_WEBHOOK_JWKS_URL} does not match the workspace (FIREBLOCKS_SANDBOX=${cfg.FIREBLOCKS_SANDBOX ?? 'unset'})`);
    if ([cfg.B2BINPAY_CLIENT_ID, cfg.B2BINPAY_CLIENT_SECRET].some(v => v && !PLACEHOLDER.test(v)) && (!cfg.B2BINPAY_CALLBACK_SECRET || PLACEHOLDER.test(cfg.B2BINPAY_CALLBACK_SECRET))) prodProblems.push('B2BINPAY_CALLBACK_SECRET is required in production');
    // Things that must be true in production (CLAUDE.md): a dedicated Solana node, deliberate outbound enablement,
    // sane limits, and a conscious choice about screening.
    if (!cfg.SOLANA_RPC_URL || /api\.(mainnet-beta|devnet|testnet)\.solana\.com/.test(cfg.SOLANA_RPC_URL)) prodProblems.push('SOLANA_RPC_URL must point at a dedicated node in production (the public endpoint rate-limits finality checks and settlements pile up unproven)');
    for (const k of ['TRANSFER_MAX_AMOUNT', 'TRANSFER_DAILY_LIMIT', 'TRANSFER_MAX_PER_HOUR'] as const) { const v = cfg[k]; if (v !== undefined && !(Number(v) > 0)) prodProblems.push(`${k} must be a positive number`); }
    if (cfg.OUTBOUND_SETTLEMENT_ENABLED !== undefined && !['true', 'false'].includes(cfg.OUTBOUND_SETTLEMENT_ENABLED)) prodProblems.push('OUTBOUND_SETTLEMENT_ENABLED must be "true" or "false"');
    if (cfg.SCREENING_OPTIONAL === 'true') console.warn('[config] SCREENING_OPTIONAL=true: external counterparties can be registered in PRODUCTION without sanctions screening — this must be a documented decision');
    if (!cfg.FIREBLOCKS_API_KEY || PLACEHOLDER.test(cfg.FIREBLOCKS_API_KEY)) prodProblems.push('FIREBLOCKS_API_KEY is required in production (without it custody is a stub and no money moves)');
    if (prodProblems.length) throw new ConfigError(prodProblems);
  }
  // A configured Fireblocks workspace and the Solana cluster must agree, in every environment: a sandbox
  // workspace only sees devnet, a live one only mainnet. A mismatch would issue addresses on one chain and
  // verify finality on the other, so deposits would never prove and settlements would stall.
  const fireblocksLive = !!cfg.FIREBLOCKS_API_KEY && !PLACEHOLDER.test(cfg.FIREBLOCKS_API_KEY);
  if (fireblocksLive) {
    const clusterProblems: string[] = [];
    const fbSandbox = cfg.FIREBLOCKS_SANDBOX === 'true';
    if (fbSandbox && cfg.SOLANA_CLUSTER !== 'devnet') clusterProblems.push('FIREBLOCKS_SANDBOX=true settles on Solana devnet: set SOLANA_CLUSTER=devnet');
    if (!fbSandbox && cfg.SOLANA_CLUSTER === 'devnet') clusterProblems.push('SOLANA_CLUSTER=devnet requires FIREBLOCKS_SANDBOX=true (a live workspace holds mainnet assets)');
    if (cfg.SOLANA_CLUSTER === 'devnet' && !cfg.FIREBLOCKS_USDC_ASSET) clusterProblems.push('SOLANA_CLUSTER=devnet requires FIREBLOCKS_USDC_ASSET (the workspace\'s id for Solana devnet USDC; `npm run fb:preflight` lists it)');
    if (cfg.SOLANA_CLUSTER === 'devnet' && cfg.SOLANA_RPC_URL && /mainnet/i.test(cfg.SOLANA_RPC_URL)) clusterProblems.push('SOLANA_CLUSTER=devnet but SOLANA_RPC_URL looks like a mainnet node');
    if (cfg.SOLANA_CLUSTER === 'mainnet' && cfg.SOLANA_RPC_URL && /devnet|testnet/i.test(cfg.SOLANA_RPC_URL)) clusterProblems.push('SOLANA_CLUSTER=mainnet but SOLANA_RPC_URL looks like a devnet/testnet node');
    // On mainnet the Fireblocks ids are the canonical ones. A leftover testnet override would make deposit
    // resolution trust that id as mainnet USDC/USDT.
    if (cfg.SOLANA_CLUSTER === 'mainnet' && cfg.FIREBLOCKS_USDC_ASSET && cfg.FIREBLOCKS_USDC_ASSET !== 'USDC_SOL') clusterProblems.push(`SOLANA_CLUSTER=mainnet requires FIREBLOCKS_USDC_ASSET unset or USDC_SOL (got ${cfg.FIREBLOCKS_USDC_ASSET})`);
    if (cfg.SOLANA_CLUSTER === 'mainnet' && cfg.FIREBLOCKS_USDT_ASSET && cfg.FIREBLOCKS_USDT_ASSET !== 'USDT_SOL') clusterProblems.push(`SOLANA_CLUSTER=mainnet requires FIREBLOCKS_USDT_ASSET unset or USDT_SOL (got ${cfg.FIREBLOCKS_USDT_ASSET})`);
    if (clusterProblems.length) throw new ConfigError(clusterProblems);
  }
  const sandboxProviders = PROVIDER_KEYS.filter(k => { const v = cfg[k]; return !v || PLACEHOLDER.test(String(v)); }).map(String);
  return { config: cfg, sandboxProviders };
}
export class ConfigError extends Error { constructor(public readonly problems: string[]) { super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`); } }

let cached: ConfigReport | undefined;
export function config(): AppConfig { if (!cached) cached = loadConfig(); return cached.config; }
export function configReport(): ConfigReport { if (!cached) cached = loadConfig(); return cached; }
export function resetConfigForTests() { cached = undefined; }
