import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../platform/config';

const runtime = vi.hoisted(() => ({
  events: [] as string[],
  validator: vi.fn(), resume: vi.fn(), outbox: vi.fn(),
}));
vi.mock('../bootstrap/lp.bootstrap', () => { runtime.events.push('liquidity'); return {}; });
vi.mock('../bootstrap/baas.bootstrap', () => { runtime.events.push('legacy-rails'); return {}; });
vi.mock('../core/payment-validator.service', () => ({ startPaymentValidator: runtime.validator }));
vi.mock('../core/settlement/resume.worker', () => ({ startResumeWorker: runtime.resume }));
vi.mock('../core/outbox.service', () => ({ startOutboxWorker: runtime.outbox }));

const cfg = () => loadConfig({ DATABASE_URL: 'postgresql://u@localhost/test', API_BASE_URL: 'http://localhost:4000/api' }).config;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  runtime.events.length = 0;
  runtime.validator.mockImplementation(async () => { runtime.events.push('validator'); });
  runtime.resume.mockImplementation(() => { runtime.events.push('resume'); });
  runtime.outbox.mockImplementation(() => { runtime.events.push('outbox'); });
});

describe('backend runtime foundation', () => {
  it('loading the runtime does not start providers or workers', async () => {
    await import('../bootstrap/runtime');
    expect(runtime.events).toEqual([]);
  });
  it('registers providers and awaits validation before starting enabled workers', async () => {
    const { startRuntime } = await import('../bootstrap/runtime');
    await startRuntime(cfg());
    expect(runtime.events).toEqual(['liquidity', 'legacy-rails', 'validator', 'resume', 'outbox']);
  });
  it('respects disabled workers', async () => {
    const { startRuntime } = await import('../bootstrap/runtime');
    await startRuntime({ ...cfg(), SETTLEMENT_WORKER_ENABLED: false, OUTBOX_WORKER_ENABLED: false });
    expect(runtime.resume).not.toHaveBeenCalled();
    expect(runtime.outbox).not.toHaveBeenCalled();
  });
  it('stops startup if validation cannot initialize', async () => {
    runtime.validator.mockRejectedValueOnce(new Error('validator unavailable'));
    const { startRuntime } = await import('../bootstrap/runtime');
    await expect(startRuntime(cfg())).rejects.toThrow('validator unavailable');
    expect(runtime.resume).not.toHaveBeenCalled();
    expect(runtime.outbox).not.toHaveBeenCalled();
  });
});
