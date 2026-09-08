/**
 * Settlement harness over HTTP.
 *
 * The same runner as `npm run simulate`, reachable from a deployed sandbox so
 * you can prove an environment works — right credentials shape, right database,
 * migrations applied — without shelling into it.
 *
 * Not to be confused with `simulate.routes.ts`, which builds an illustrative
 * step-by-step narrative for the frontend and never touches the engine. This
 * one runs real settlements.
 *
 * Mounted only when SIMULATOR_ENABLED=true, and additionally gated by
 * OPS_API_KEY. It writes to the database and stubs the payment rails, so an
 * environment where either of those is a bad idea simply does not expose it.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { run, cleanupOrphans, SCENARIOS, SimulatorRefused } from '../simulator/runner';

const router = Router();

function requireOpsKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.OPS_API_KEY ?? '';
  if (!expected) {
    res.status(503).json({ error: 'OPS_API_KEY is not configured — harness endpoints are disabled' });
    return;
  }
  const provided = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  let diff = provided.length ^ expected.length;
  for (let i = 0; i < Math.min(provided.length, expected.length); i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

router.use(requireOpsKey);

router.get('/scenarios', (_req, res) => {
  res.json({
    count: SCENARIOS.length,
    scenarios: SCENARIOS.map(s => ({ id: s.id, title: s.title, proves: s.proves })),
  });
});

/**
 * Run the harness. A long request by design — the whole suite settles in a
 * few seconds against stubs, and streaming partial results would make the
 * pass/fail contract worse, not better.
 */
router.post('/run', (req: Request, res: Response, next: NextFunction) => {
  const body = (req.body ?? {}) as { only?: string[] | string; keepData?: boolean };
  const only = Array.isArray(body.only) ? body.only : body.only ? [body.only] : undefined;

  run({ only, keepData: body.keepData === true })
    .then(report => {
      // The HTTP status carries the result so a CI check can gate on it
      // without parsing the body.
      res.status(report.passed ? 200 : 422).json(report);
    })
    .catch(err => {
      if (err instanceof SimulatorRefused) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    });
});

/** Remove simulated data left behind by an interrupted run. */
router.post('/cleanup', (_req, res, next) => {
  cleanupOrphans()
    .then(removed => res.json({ ok: true, removed }))
    .catch(next);
});

export default router;
