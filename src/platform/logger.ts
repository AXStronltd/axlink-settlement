/**
 * Structured JSON logging with request correlation. One line per event, machine-readable,
 * no secrets: values under keys that look like credentials are redacted before output.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT = /(secret|password|token|api[_-]?key|authorization|private[_-]?key|signature)/i;
const ctx = new AsyncLocalStorage<{ requestId: string; institutionId?: string }>();

let minLevel: Level = (process.env.LOG_LEVEL as Level) || 'info';
export function setLogLevel(l: Level) { minLevel = l; }
export const sink = { write: (line: string) => { process.stdout.write(line + '\n'); } };

function redact(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = REDACT.test(k) ? '[REDACTED]' : redact(val, depth + 1);
  return out;
}
function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[minLevel]) return;
  const c = ctx.getStore();
  sink.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(c?.requestId ? { requestId: c.requestId } : {}), ...(c?.institutionId ? { institutionId: c.institutionId } : {}), ...(fields ? (redact(fields) as object) : {}) }));
}
export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit('error', msg, f),
  requestId: () => ctx.getStore()?.requestId,
  setInstitution: (id: string) => { const s = ctx.getStore(); if (s) s.institutionId = id; },
};

/** Request-id middleware: honours an incoming X-Request-Id (≤ 64 safe chars), otherwise mints one. Logs one access line per request. */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incoming = String(req.headers['x-request-id'] ?? '');
  const requestId = /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', requestId);
  (req as Request & { requestId: string }).requestId = requestId;
  const started = Date.now();
  res.on('finish', () => emit(res.statusCode >= 500 ? 'error' : 'info', 'http', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started, requestId }));
  ctx.run({ requestId }, () => next());
}
