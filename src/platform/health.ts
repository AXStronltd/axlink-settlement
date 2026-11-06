/**
 * Liveness (/api/health) says the process is up. Readiness (/api/ready) says it can serve:
 * database reachable and every migration applied. Readiness is what a load balancer should use.
 */
import { Router } from 'express';
import { prisma } from '../core/ledger.service';
import { configReport } from './config';

export const SERVICE = 'axlink-settlement';
export const VERSION = process.env.npm_package_version ?? '2.0.0';

export async function readiness(): Promise<{ ok: boolean; checks: Record<string, { ok: boolean; detail?: string; ms?: number }> }> {
  const checks: Record<string, { ok: boolean; detail?: string; ms?: number }> = {};
  const t = Date.now();
  try { await prisma.$queryRaw`SELECT 1`; checks.database = { ok: true, ms: Date.now() - t }; }
  catch (e) { checks.database = { ok: false, detail: (e as Error).message, ms: Date.now() - t }; }
  if (checks.database.ok) {
    try {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "_prisma_migrations" WHERE finished_at IS NULL`;
      const pending = Number(rows[0]?.n ?? 0); checks.migrations = { ok: pending === 0, detail: pending ? `${pending} unfinished migration(s)` : undefined };
    } catch { checks.migrations = { ok: false, detail: '_prisma_migrations table missing: run prisma migrate deploy' }; }
  }
  return { ok: Object.values(checks).every(c => c.ok), checks };
}

export function healthRouter() {
  const r = Router();
  r.get(['/health', '/api/health'], (_req, res) => {
    const { sandboxProviders } = configReport();
    res.json({ status: 'ok', service: SERVICE, version: VERSION, timestamp: new Date().toISOString(), sandbox: sandboxProviders.length > 0 });
  });
  r.get(['/ready', '/api/ready'], async (_req, res) => { const r = await readiness(); res.status(r.ok ? 200 : 503).json({ status: r.ok ? 'ready' : 'not_ready', ...r }); });
  return r;
}
