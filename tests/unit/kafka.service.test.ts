import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// Reset module state between tests so singleton bus is fresh
vi.resetModules();

async function freshModule() {
  vi.resetModules();
  // No KAFKA_BROKERS → local bus
  delete process.env.KAFKA_BROKERS;
  const mod = await import('../../packages/core/events/kafka.service');
  return mod;
}

describe('LocalEventBus', () => {
  it('publish → subscribe delivers the event', async () => {
    const { getEventBus } = await freshModule();
    const bus = await getEventBus();
    const received: unknown[] = [];
    await bus.subscribe('test.topic', async (e) => { received.push(e); });
    await bus.publish('test.topic', { hello: 'world' });
    // setImmediate defers publish
    await new Promise(r => setImmediate(r));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ hello: 'world' });
  });

  it('different topics do not bleed', async () => {
    const { getEventBus } = await freshModule();
    const bus = await getEventBus();
    const aEvents: unknown[] = [];
    const bEvents: unknown[] = [];
    await bus.subscribe('topic.a', async (e) => { aEvents.push(e); });
    await bus.subscribe('topic.b', async (e) => { bEvents.push(e); });
    await bus.publish('topic.a', { tag: 'a' });
    await new Promise(r => setImmediate(r));
    expect(aEvents).toHaveLength(1);
    expect(bEvents).toHaveLength(0);
  });
});

describe('requestValidation', () => {
  it('resolves approved when validator approves', async () => {
    const { getEventBus, requestValidation, TOPICS } = await freshModule();
    const bus = await getEventBus();

    // Simulate validator: approve everything
    await bus.subscribe(TOPICS.VALIDATION_REQUESTED, async (raw: unknown) => {
      const req = raw as { correlationId: string };
      await bus.publish(TOPICS.VALIDATION_RESULT, {
        correlationId: req.correlationId,
        approved: true,
        timestamp: new Date().toISOString(),
      });
    });

    const result = await requestValidation({
      type: 'DEPOSIT',
      payload: { userId: 'u1', currency: 'KES', amount: 1000, rail: 'mpesa' },
    });

    expect(result.approved).toBe(true);
    expect(result.correlationId).toBeTypeOf('string');
  });

  it('resolves rejected with reason', async () => {
    const { getEventBus, requestValidation, TOPICS } = await freshModule();
    const bus = await getEventBus();

    await bus.subscribe(TOPICS.VALIDATION_REQUESTED, async (raw: unknown) => {
      const req = raw as { correlationId: string };
      await bus.publish(TOPICS.VALIDATION_RESULT, {
        correlationId: req.correlationId,
        approved: false,
        reason: 'KYC not approved',
        timestamp: new Date().toISOString(),
      });
    });

    const result = await requestValidation({
      type: 'WITHDRAWAL',
      payload: { userId: 'u2', currency: 'GBP', amount: 100, destination: { name: 'Bob' } },
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toBe('KYC not approved');
  });

  it('times out when no validator responds', async () => {
    const { requestValidation } = await freshModule();

    await expect(
      requestValidation(
        { type: 'DEPOSIT', payload: { userId: 'u3', currency: 'KES', amount: 500, rail: 'mpesa' } },
        100, // 100ms timeout for fast test
      )
    ).rejects.toThrow(/timed out/i);
  }, 2000);

  it('correlationId isolation — two concurrent requests each resolve their own', async () => {
    const { getEventBus, requestValidation, TOPICS } = await freshModule();
    const bus = await getEventBus();

    // Validator echoes back with a 10ms delay
    await bus.subscribe(TOPICS.VALIDATION_REQUESTED, async (raw: unknown) => {
      const req = raw as { correlationId: string; payload: { amount: number } };
      await new Promise(r => setTimeout(r, 10));
      await bus.publish(TOPICS.VALIDATION_RESULT, {
        correlationId: req.correlationId,
        approved: req.payload.amount > 0,
        reason: req.payload.amount <= 0 ? 'zero amount' : undefined,
        timestamp: new Date().toISOString(),
      });
    });

    const [r1, r2] = await Promise.all([
      requestValidation({ type: 'DEPOSIT', payload: { userId: 'u1', currency: 'KES', amount: 100, rail: 'mpesa' } }),
      requestValidation({ type: 'DEPOSIT', payload: { userId: 'u2', currency: 'GBP', amount: -1, rail: 'brainrock' } }),
    ]);

    expect(r1.approved).toBe(true);
    expect(r2.approved).toBe(false);
    expect(r1.correlationId).not.toBe(r2.correlationId);
  });

  it('does NOT accumulate listeners on repeated calls', async () => {
    const { getEventBus, requestValidation, TOPICS } = await freshModule();
    const bus = await getEventBus();

    await bus.subscribe(TOPICS.VALIDATION_REQUESTED, async (raw: unknown) => {
      const req = raw as { correlationId: string };
      await bus.publish(TOPICS.VALIDATION_RESULT, {
        correlationId: req.correlationId,
        approved: true,
        timestamp: new Date().toISOString(),
      });
    });

    // Make 20 validation calls
    for (let i = 0; i < 20; i++) {
      await requestValidation({
        type: 'DEPOSIT',
        payload: { userId: `u${i}`, currency: 'KES', amount: 100, rail: 'mpesa' },
      });
    }

    // Access the internal bus EventEmitter and check listener count
    const internalBus = bus as unknown as { ee?: EventEmitter };
    if (internalBus.ee) {
      const listenerCount = internalBus.ee.listenerCount(TOPICS.VALIDATION_RESULT);
      // Must be exactly 1 (the singleton subscriber) not 20
      expect(listenerCount).toBe(1);
    }
  });
});
