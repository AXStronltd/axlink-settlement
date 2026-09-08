/**
 * APPRA Event Bus
 *
 * Real Kafka (KafkaJS) when KAFKA_BROKERS is set.
 * In-process EventEmitter fallback for sandbox/dev — same interface, no broker needed.
 *
 * All payment flows publish a `payment.validation.requested` event before touching
 * the ledger. The validator consumer responds with `payment.validation.result`.
 * Only APPROVED events proceed to settlement.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

// ── Event shapes ──────────────────────────────────────────────────────────────

export type PaymentType = 'P2P_TRANSFER' | 'DEPOSIT' | 'WITHDRAWAL';

export interface ValidationRequestedEvent {
  correlationId: string;
  type: PaymentType;
  payload: {
    userId?: string;
    senderId?: string;
    receiverId?: string;
    currency?: string;
    fromCurrency?: string;
    toCurrency?: string;
    amount: number;
    rail?: string;
    destination?: Record<string, unknown>;
  };
  timestamp: string;
}

export interface ValidationResultEvent {
  correlationId: string;
  approved: boolean;
  reason?: string;
  timestamp: string;
}

export const TOPICS = {
  VALIDATION_REQUESTED: 'fincruise.payment.validation.requested',
  VALIDATION_RESULT:    'fincruise.payment.validation.result',
  PAYMENT_SETTLED:      'fincruise.payment.settled',
  PAYMENT_FAILED:       'fincruise.payment.failed',
} as const;

// ── Producer / Consumer interface ─────────────────────────────────────────────

export interface EventBus {
  publish(topic: string, event: unknown): Promise<void>;
  subscribe(topic: string, handler: (event: unknown) => Promise<void>): Promise<void>;
  disconnect(): Promise<void>;
}

// ── Local EventEmitter bus (sandbox mode) ─────────────────────────────────────

class LocalEventBus implements EventBus {
  private ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(50);
  }

  async publish(topic: string, event: unknown): Promise<void> {
    // Use setImmediate so publish returns before subscribers fire — mirrors Kafka async semantics
    setImmediate(() => this.ee.emit(topic, event));
  }

  async subscribe(topic: string, handler: (event: unknown) => Promise<void>): Promise<void> {
    this.ee.on(topic, (event: unknown) => {
      handler(event).catch(err => console.error(`[EventBus] Handler error on ${topic}:`, err));
    });
  }

  async disconnect(): Promise<void> {
    this.ee.removeAllListeners();
  }
}

// ── KafkaJS bus (production mode) ─────────────────────────────────────────────

async function buildKafkaBus(brokers: string[]): Promise<EventBus> {
  const { Kafka } = await import('kafkajs');
  const kafka = new Kafka({
    clientId: 'fincruise-settlement',
    brokers,
    retry: { retries: 3 },
  });

  const producer = kafka.producer();
  await producer.connect();

  const consumers = new Map<string, ReturnType<typeof kafka.consumer>>();

  return {
    async publish(topic: string, event: unknown): Promise<void> {
      await producer.send({
        topic,
        messages: [{ key: randomUUID(), value: JSON.stringify(event) }],
      });
    },

    async subscribe(topic: string, handler: (event: unknown) => Promise<void>): Promise<void> {
      const consumer = kafka.consumer({ groupId: `fincruise-${topic}-group` });
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: false });
      await consumer.run({
        eachMessage: async ({ message }) => {
          if (!message.value) return;
          try {
            const event = JSON.parse(message.value.toString());
            await handler(event);
          } catch (err) {
            console.error(`[Kafka] Parse/handler error on ${topic}:`, err);
          }
        },
      });
      consumers.set(topic, consumer);
    },

    async disconnect(): Promise<void> {
      for (const consumer of consumers.values()) await consumer.disconnect();
      await producer.disconnect();
    },
  };
}

// ── Singleton bus ─────────────────────────────────────────────────────────────

let _bus: EventBus | null = null;

export async function getEventBus(): Promise<EventBus> {
  if (_bus) return _bus;

  const brokers = process.env.KAFKA_BROKERS;
  if (brokers) {
    console.log(`[EventBus] Connecting to Kafka: ${brokers}`);
    _bus = await buildKafkaBus(brokers.split(',').map(b => b.trim()));
  } else {
    console.log('[EventBus] No KAFKA_BROKERS — using local in-process event bus (sandbox)');
    _bus = new LocalEventBus();
  }

  return _bus;
}

// ── Request/reply helper (correlation ID pattern) ─────────────────────────────
// One global subscriber on VALIDATION_RESULT; resolvers tracked by correlationId.
// Avoids adding a new listener on every payment (memory leak prevention).

const _pendingValidations = new Map<string, (result: ValidationResultEvent) => void>();
let _resultSubscribed = false;

async function ensureResultSubscribed(): Promise<void> {
  if (_resultSubscribed) return;
  _resultSubscribed = true;
  const bus = await getEventBus();
  await bus.subscribe(TOPICS.VALIDATION_RESULT, async (raw) => {
    const result = raw as ValidationResultEvent;
    const resolver = _pendingValidations.get(result.correlationId);
    if (resolver) {
      _pendingValidations.delete(result.correlationId);
      resolver(result);
    }
  });
}

export async function requestValidation(
  event: Omit<ValidationRequestedEvent, 'correlationId' | 'timestamp'>,
  timeoutMs = 8_000,
): Promise<ValidationResultEvent> {
  await ensureResultSubscribed();
  const bus = await getEventBus();
  const correlationId = randomUUID();

  const request: ValidationRequestedEvent = {
    ...event,
    correlationId,
    timestamp: new Date().toISOString(),
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pendingValidations.delete(correlationId);
      reject(new Error(`[EventBus] Validation timed out after ${timeoutMs}ms (correlationId: ${correlationId})`));
    }, timeoutMs);

    _pendingValidations.set(correlationId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });

    bus.publish(TOPICS.VALIDATION_REQUESTED, request).catch((err) => {
      _pendingValidations.delete(correlationId);
      clearTimeout(timer);
      reject(err);
    });
  });
}
