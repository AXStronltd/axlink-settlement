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
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
  DEMO_ENABLED: bool,
  SETTLEMENT_WORKER_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  OUTBOX_WORKER_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  // Provider credentials — optional; unset = stubbed (sandbox mode).
  FIREBLOCKS_API_KEY: z.string().optional(), FIREBLOCKS_TREASURY_VAULT: z.string().optional(),
  B2BINPAY_CLIENT_ID: z.string().optional(), B2BINPAY_CLIENT_SECRET: z.string().optional(),
  BRAINROCK_API_KEY: z.string().optional(), BRAINROCK_TREASURY_ACCOUNT_ID: z.string().optional(),
  CHOICE_BANK_API_KEY: z.string().optional(), DARAJA_CONSUMER_KEY: z.string().optional(), DARAJA_CONSUMER_SECRET: z.string().optional(),
  SOLANA_RPC_URL: z.string().url().optional(),
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
  if (cfg.NODE_ENV === 'production') {
    const prodProblems: string[] = [];
    if (!cfg.FIREBLOCKS_WORKSPACE_ID || PLACEHOLDER.test(cfg.FIREBLOCKS_WORKSPACE_ID)) prodProblems.push('FIREBLOCKS_WORKSPACE_ID is required in production');
    if (!cfg.OPS_API_KEY) prodProblems.push('OPS_API_KEY is required in production');
    if (cfg.SIMULATOR_ENABLED) prodProblems.push('SIMULATOR_ENABLED must be false in production');
    if (cfg.DEMO_ENABLED) prodProblems.push('DEMO_ENABLED must be false in production');
    if (cfg.ALLOW_UNVERIFIED_WEBHOOKS) prodProblems.push('ALLOW_UNVERIFIED_WEBHOOKS must be false in production');
    if (!cfg.WEBHOOK_ENCRYPTION_KEY || PLACEHOLDER.test(cfg.WEBHOOK_ENCRYPTION_KEY)) prodProblems.push('WEBHOOK_ENCRYPTION_KEY is required in production');
    // F2: a crypto-settlement webhook that cannot be verified is refused at runtime (503); in production
    // that is an outage, so the keys are required at boot.
    if (!cfg.FIREBLOCKS_WEBHOOK_JWKS_URL && (!cfg.FIREBLOCKS_WEBHOOK_PUBLIC_KEY || PLACEHOLDER.test(cfg.FIREBLOCKS_WEBHOOK_PUBLIC_KEY))) prodProblems.push('FIREBLOCKS_WEBHOOK_PUBLIC_KEY is required in production');
    if ([cfg.B2BINPAY_CLIENT_ID, cfg.B2BINPAY_CLIENT_SECRET].some(v => v && !PLACEHOLDER.test(v)) && (!cfg.B2BINPAY_CALLBACK_SECRET || PLACEHOLDER.test(cfg.B2BINPAY_CALLBACK_SECRET))) prodProblems.push('B2BINPAY_CALLBACK_SECRET is required in production');
    if (prodProblems.length) throw new ConfigError(prodProblems);
  }
  const sandboxProviders = PROVIDER_KEYS.filter(k => { const v = cfg[k]; return !v || PLACEHOLDER.test(String(v)); }).map(String);
  return { config: cfg, sandboxProviders };
}
export class ConfigError extends Error { constructor(public readonly problems: string[]) { super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`); } }

let cached: ConfigReport | undefined;
export function config(): AppConfig { if (!cached) cached = loadConfig(); return cached.config; }
export function configReport(): ConfigReport { if (!cached) cached = loadConfig(); return cached; }
export function resetConfigForTests() { cached = undefined; }
