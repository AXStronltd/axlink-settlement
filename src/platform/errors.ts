/**
 * Standard API error shape: { error: { code, message, requestId, details? } }.
 * Existing callers throw plain Errors with a `code` and optional `statusCode`; the handler
 * keeps honouring those so nothing already working changes shape except for the envelope.
 */
import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { log } from './logger';

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400, public readonly details?: unknown) { super(message); }
}
export const notFound = (what: string) => new ApiError('NOT_FOUND', `${what} not found`, 404);
export const unauthorized = (msg = 'Authentication required') => new ApiError('UNAUTHORIZED', msg, 401);
export const forbidden = (msg = 'Forbidden') => new ApiError('FORBIDDEN', msg, 403);

/** Codes thrown by existing services as plain Errors; they map to 422 unless they carry statusCode. */
const KNOWN_422 = new Set(['PAYMENT_REJECTED', 'RATE_PROTECTION_TRIGGERED', 'DAILY_LIMIT_EXCEEDED', 'CORRIDOR_LIMIT_EXCEEDED', 'UNKNOWN_RECEIVER_BANK', 'RECEIVER_BANK_SUSPENDED', 'SELF_TRANSFER', 'DUPLICATE_REFERENCE', 'IDEMPOTENCY_CONFLICT', 'REQUEST_IN_FLIGHT', 'NO_FUNDING_ROUTE', 'INSUFFICIENT_BALANCE', 'INVALID_AMOUNT', 'VAULT_NOT_PROVISIONED', 'PROVIDER_CIRCUIT_OPEN', 'ALL_PROVIDERS_UNAVAILABLE', 'UNBALANCED_POSTING', 'SETTLEMENT_PROOF_MISMATCH', 'SETTLEMENT_NOT_FINAL', 'VALIDATION_ERROR']);

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = (req as Request & { requestId?: string }).requestId ?? log.requestId();
  const body = (code: string, message: string, status: number, details?: unknown) => {
    res.status(status).json({ error: { code, message, requestId, ...(details !== undefined ? { details } : {}) }, // new envelope
      // legacy top-level fields kept for existing clients and tests
      code, message });
  };
  if (err instanceof ApiError) return body(err.code, err.message, err.statusCode, err.details);
  if (err instanceof ZodError) return body('VALIDATION_ERROR', 'Request validation failed', 400, err.issues.map(i => ({ path: i.path.join('.'), message: i.message })));
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; statusCode?: unknown; message?: unknown; type?: unknown };
    if (e.type === 'entity.parse.failed') return body('MALFORMED_JSON', 'Request body is not valid JSON', 400);
    if (typeof e.code === 'string' && KNOWN_422.has(e.code)) return body(e.code, String(e.message ?? e.code), typeof e.statusCode === 'number' ? e.statusCode : 422);
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && (e.statusCode < 500 || e.code === 'LEGACY_FINANCIAL_API_DISABLED')) return body(typeof e.code === 'string' ? e.code : 'BAD_REQUEST', String(e.message ?? 'Bad request'), e.statusCode);
  }
  const message = err instanceof Error ? err.message : String(err);
  log.error('unhandled', { message, stack: err instanceof Error ? err.stack : undefined });
  // never leak internals in production
  body('INTERNAL_ERROR', process.env.NODE_ENV === 'production' ? 'Internal server error' : message, 500);
}
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}`, requestId: (req as Request & { requestId?: string }).requestId }, code: 'NOT_FOUND', message: 'Not found' });
}
