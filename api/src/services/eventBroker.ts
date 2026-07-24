import { z } from 'zod';
import Redis from 'ioredis';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../logger';
import { getPool } from './db';

// ─── Event Schemas ──────────────────────────────────────────────────────────

export const FundingRequestedSchema = z.object({
  txHash: z.string(),
  sourceAddress: z.string(),
  targetAddress: z.string(),
  tokenAddress: z.string(),
  amount: z.string(),
  feeBps: z.number(),
  memo: z.string().optional(),
  signedXdr: z.string(),
});

export const FundingCompletedSchema = z.object({
  txHash: z.string(),
  sourceAddress: z.string(),
  targetAddress: z.string(),
  tokenAddress: z.string(),
  amount: z.string(),
  feeBps: z.number(),
  fee: z.string().optional(),
  completedAt: z.number(),
});

export const FundingFailedSchema = z.object({
  txHash: z.string(),
  sourceAddress: z.string().optional(),
  targetAddress: z.string().optional(),
  tokenAddress: z.string().optional(),
  amount: z.string().optional(),
  error: z.string(),
  failedAt: z.number(),
});

export const FeeWithdrawnSchema = z.object({
  amount: z.string(),
  to: z.string(),
  withdrawnAt: z.number(),
});

export const WebhookReceivedSchema = z.object({
  provider: z.enum(['moonpay', 'transak']),
  payload: z.any(),
  receivedAt: z.number(),
});

export type FundingRequestedEvent = z.infer<typeof FundingRequestedSchema>;
export type FundingCompletedEvent = z.infer<typeof FundingCompletedSchema>;
export type FundingFailedEvent = z.infer<typeof FundingFailedSchema>;
export type FeeWithdrawnEvent = z.infer<typeof FeeWithdrawnSchema>;
export type WebhookReceivedEvent = z.infer<typeof WebhookReceivedSchema>;

export type DomainEvent =
  | { type: 'FundingRequested'; data: FundingRequestedEvent }
  | { type: 'FundingCompleted'; data: FundingCompletedEvent }
  | { type: 'FundingFailed'; data: FundingFailedEvent }
  | { type: 'FeeWithdrawn'; data: FeeWithdrawnEvent }
  | { type: 'WebhookReceived'; data: WebhookReceivedEvent };

// ─── Event Broker Implementation ─────────────────────────────────────────────

type ConsumerFn = (data: any) => Promise<void>;

export class EventBroker {
  private redisPub: Redis | null = null;
  private redisSub: Redis | null = null;
  private consumers: Map<string, ConsumerFn[]> = new Map();
  private inMemoryEvents: Array<{ sequence: number; event_id: string; event_type: string; payload: string; created_at: number }> = [];
  private inMemoryDlq: Array<{ id: string; event_type: string; payload: string; error: string; failed_at: number }> = [];
  private nextInMemorySequence = 1;
  private consuming = false;
  private streamKey = 'bridge:events';
  private groupName = 'bridge:consumers';
  private consumerName = `consumer-${crypto.randomUUID().slice(0, 8)}`;

  constructor() {
    this.initPubSub();
  }

  private initPubSub() {
    if (!config.redis.url) return;

    try {
      this.redisPub = new Redis(config.redis.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        enableOfflineQueue: false,
      });
      this.redisPub.on('error', (err) => {
        logger.debug({ err: err.message }, 'EventBroker publisher connection error');
      });

      this.redisSub = new Redis(config.redis.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        enableOfflineQueue: false,
      });
      this.redisSub.on('error', (err) => {
        logger.debug({ err: err.message }, 'EventBroker subscriber connection error');
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to initialize Redis clients in EventBroker');
    }
  }

  /** Validate event payload using corresponding Zod schemas. */
  validateEvent(event: DomainEvent): void {
    switch (event.type) {
      case 'FundingRequested':
        FundingRequestedSchema.parse(event.data);
        break;
      case 'FundingCompleted':
        FundingCompletedSchema.parse(event.data);
        break;
      case 'FundingFailed':
        FundingFailedSchema.parse(event.data);
        break;
      case 'FeeWithdrawn':
        FeeWithdrawnSchema.parse(event.data);
        break;
      case 'WebhookReceived':
        WebhookReceivedSchema.parse(event.data);
        break;
      default:
        throw new Error(`Unknown event type: ${(event as any).type}`);
    }
  }

  /** Publish an event. */
  async publish(event: DomainEvent): Promise<void> {
    this.validateEvent(event);

    const eventId = crypto.randomUUID();
    const payloadStr = JSON.stringify(event.data);
    const createdAt = Date.now();

    // 1. Persist Event (Event Sourcing)
    let sequence = 0;
    const pool = getPool();
    if (pool) {
      try {
        const res = await pool.query(
          `INSERT INTO event_store (event_id, event_type, payload, created_at)
           VALUES ($1, $2, $3, $4)
           RETURNING sequence`,
          [eventId, event.type, payloadStr, createdAt]
        );
        sequence = parseInt(res.rows[0].sequence, 10);
      } catch (err) {
        logger.error({ err }, 'Failed to persist event in Database event_store');
      }
    }

    // Always maintain in-memory log for local audit/replay/testing
    if (sequence === 0) {
      sequence = this.nextInMemorySequence++;
    }
    this.inMemoryEvents.push({
      sequence,
      event_id: eventId,
      event_type: event.type,
      payload: payloadStr,
      created_at: createdAt,
    });

    // 2. Publish to Broker (Redis Stream)
    let publishedToBroker = false;
    if (this.redisPub) {
      try {
        await this.redisPub.xadd(
          this.streamKey,
          '*',
          'eventId', eventId,
          'type', event.type,
          'payload', payloadStr,
          'createdAt', String(createdAt)
        );
        publishedToBroker = true;
        logger.info({ eventId, type: event.type }, 'Event published to Redis Stream');
      } catch (err) {
        logger.warn({ err: String(err) }, 'Redis Stream broker publish failed; falling back to sync');
      }
    }

    // 3. Fallback to synchronous execution if broker is unavailable
    if (!publishedToBroker) {
      logger.info({ eventId, type: event.type }, 'Dispatching event locally/synchronously');
      // Execute asynchronously in microtask queue so publish returns immediately
      setImmediate(() => {
        this.dispatchLocal(event).catch((err) => {
          logger.error({ err, type: event.type }, 'Local synchronous event dispatch failed');
        });
      });
    }
  }

  /** Subscribe a consumer to an event type. */
  subscribe(eventType: DomainEvent['type'], consumer: ConsumerFn): void {
    const list = this.consumers.get(eventType) || [];
    list.push(consumer);
    this.consumers.set(eventType, list);
  }

  /** Dispatch the event to all matching local consumers. */
  async dispatchLocal(event: DomainEvent): Promise<void> {
    const list = this.consumers.get(event.type) || [];
    for (const consumer of list) {
      await consumer(event.data);
    }
  }

  /** Replay events from the event store. */
  async replay(sequenceStart: number, sequenceEnd?: number): Promise<void> {
    logger.info({ sequenceStart, sequenceEnd }, 'Starting event replay');
    let eventsToReplay: Array<{ event_type: string; payload: string }> = [];

    const pool = getPool();
    if (pool) {
      try {
        const query = sequenceEnd
          ? `SELECT event_type, payload FROM event_store WHERE sequence >= $1 AND sequence <= $2 ORDER BY sequence ASC`
          : `SELECT event_type, payload FROM event_store WHERE sequence >= $1 ORDER BY sequence ASC`;
        const params = sequenceEnd ? [sequenceStart, sequenceEnd] : [sequenceStart];
        const res = await pool.query(query, params);
        eventsToReplay = res.rows;
      } catch (err) {
        logger.error({ err }, 'Failed to read events from Database for replay');
      }
    }

    if (eventsToReplay.length === 0) {
      // Use in-memory log
      eventsToReplay = this.inMemoryEvents
        .filter((e) => e.sequence >= sequenceStart && (sequenceEnd === undefined || e.sequence <= sequenceEnd))
        .map((e) => ({ event_type: e.event_type, payload: e.payload }));
    }

    for (const e of eventsToReplay) {
      const data = JSON.parse(e.payload);
      logger.info({ type: e.event_type }, 'Replaying event');
      await this.dispatchLocal({ type: e.event_type, data } as DomainEvent);
    }
  }

  /** Dead Letter Queue persistence. */
  async moveToDLQ(eventType: string, payload: any, error: Error): Promise<void> {
    const id = crypto.randomUUID();
    const payloadStr = JSON.stringify(payload);
    const failedAt = Date.now();

    const pool = getPool();
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO event_dlq (id, event_type, payload, error, failed_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, eventType, payloadStr, error.message, failedAt]
        );
      } catch (err) {
        logger.error({ err }, 'Failed to persist DLQ entry in Database');
      }
    }

    this.inMemoryDlq.push({
      id,
      event_type: eventType,
      payload: payloadStr,
      error: error.message,
      failed_at: failedAt,
    });

    logger.error({ id, eventType, error: error.message }, 'Event moved to Dead Letter Queue');
  }

  /** Start background consuming loop for Redis Stream. */
  async startConsuming(): Promise<void> {
    if (this.consuming || !this.redisSub) return;
    this.consuming = true;

    try {
      await this.redisSub.connect();
    } catch {
      // Already connected or lazy-connect handles it
    }

    // Create consumer group
    try {
      await this.redisSub.xgroup('CREATE', this.streamKey, this.groupName, '$', 'MKSTREAM');
    } catch (err: any) {
      if (!err.message?.includes('BUSYGROUP')) {
        logger.error({ err }, 'Failed to create Redis Stream consumer group');
      }
    }

    logger.info({ group: this.groupName, consumer: this.consumerName }, 'Started EventBroker Redis Streams consumer group reader');

    // Run processing loop
    setImmediate(() => void this.consumeLoop());
  }

  private async consumeLoop(): Promise<void> {
    while (this.consuming && this.redisSub) {
      try {
        // Read new messages from group
        const results = await this.redisSub.xreadgroup(
          'GROUP', this.groupName, this.consumerName,
          'BLOCK', '2000', 'COUNT', '10',
          'STREAMS', this.streamKey, '>'
        );

        if (!results) continue;

        for (const [stream, messages] of results) {
          for (const [id, fields] of messages) {
            // Parse message fields
            const data: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) {
              data[fields[i]] = fields[i + 1];
            }

            const eventType = data.type;
            const payload = JSON.parse(data.payload);

            const domainEvent = { type: eventType, data } as unknown as DomainEvent;

            let success = false;
            let lastError: Error | null = null;

            // Attempt processing with up to 3 retries
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const list = this.consumers.get(eventType) || [];
                for (const consumer of list) {
                  await consumer(payload);
                }
                success = true;
                break;
              } catch (err: any) {
                lastError = err instanceof Error ? err : new Error(String(err));
                logger.warn({ eventId: id, attempt, err: lastError.message }, 'Failed event processing attempt');
                if (attempt < 3) {
                  await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
                }
              }
            }

            if (success) {
              // Acknowledge message
              await this.redisSub.xack(this.streamKey, this.groupName, id);
            } else {
              // Move to DLQ and acknowledge to remove it from the pending stream list
              await this.moveToDLQ(eventType, payload, lastError || new Error('Unknown event processing error'));
              await this.redisSub.xack(this.streamKey, this.groupName, id);
            }
          }
        }
      } catch (err: any) {
        logger.error({ err: err.message }, 'Error in EventBroker consume loop');
        // Backoff on stream error
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  /** Stop background consuming. */
  async stopConsuming(): Promise<void> {
    this.consuming = false;
    if (this.redisSub) {
      try {
        await this.redisSub.quit();
      } catch {
        // Ignore
      }
    }
    if (this.redisPub) {
      try {
        await this.redisPub.quit();
      } catch {
        // Ignore
      }
    }
    logger.info('EventBroker background consumers stopped');
  }

  async getEventByTxHash(txHash: string): Promise<FundingRequestedEvent | null> {
    const pool = getPool();
    if (pool) {
      try {
        const res = await pool.query(
          `SELECT payload FROM event_store WHERE event_type = 'FundingRequested' AND payload::jsonb->>'txHash' = $1 LIMIT 1`,
          [txHash]
        );
        if (res.rows.length > 0) {
          return JSON.parse(res.rows[0].payload) as FundingRequestedEvent;
        }
      } catch (err) {
        logger.error({ err }, 'Failed to query event_store by txHash');
      }
    }

    // Fallback to in-memory store
    for (const e of this.inMemoryEvents) {
      if (e.event_type === 'FundingRequested') {
        const data = JSON.parse(e.payload) as FundingRequestedEvent;
        if (data.txHash === txHash) {
          return data;
        }
      }
    }

    return null;
  }

  // ─── Test Helpers ──────────────────────────────────────────────────────────

  _getInMemoryEvents() {
    return this.inMemoryEvents;
  }

  _getInMemoryDlq() {
    return this.inMemoryDlq;
  }

  _clearInMemory() {
    this.inMemoryEvents = [];
    this.inMemoryDlq = [];
    this.nextInMemorySequence = 1;
    this.consumers.clear();
  }
}

export const eventBroker = new EventBroker();
