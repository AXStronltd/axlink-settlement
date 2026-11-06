import { timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { ApiError } from './errors';
/** Operator auth: Bearer OPS_API_KEY, constant-time compare. 503 when not configured (never silently open). */
export function requireOps(req: Request, _res: Response, next: NextFunction) {
  const expected = config().OPS_API_KEY ?? '';
  if (!expected) return next(new ApiError('OPS_DISABLED', 'OPS_API_KEY is not configured — operator endpoints are disabled', 503));
  const provided = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(provided), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return next(new ApiError('UNAUTHORIZED', 'Unauthorized', 401));
  next();
}
