import { Job } from 'bullmq';
import { CleanupData } from '../queue';
import { getCacheClient, isRedisEnabled } from '../../services/cache';
import type Redis from 'ioredis';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

let _testRedisClient: Redis | null | undefined = undefined;

/** Override Redis client for unit tests. Pass undefined to restore default behavior. */
export function setCleanupRedisClientForTesting(client: Redis | null | undefined): void {
  _testRedisClient = client;
}

export interface CleanupResult {
  prunedCount: number;
}

/**
 * Process cleanup job.
 * Scans Redis for idempotency keys and prunes orphan/expired keys that have no TTL set.
 * Standard idempotency keys have a 24h TTL, but orphaned or legacy keys without TTL
 * can accumulate and leak memory.
 */
export async function processCleanup(job: Job<CleanupData>): Promise<CleanupResult> {
  const olderThanMs = job.data?.olderThanMs ?? 7 * 24 * 60 * 60 * 1000;
  let prunedCount = 0;

  const redis = _testRedisClient !== undefined
    ? _testRedisClient
    : (isRedisEnabled() ? getCacheClient() : null);

  if (redis) {
    try {
      const keys = await redis.keys('idempotency:*');
      for (const key of keys) {
        const ttl = await redis.ttl(key);
        // TTL -1 indicates key exists with no expiration set (orphan)
        if (ttl === -1) {
          await redis.del(key);
          prunedCount++;
        }
      }
    } catch (error) {
      logger.warn({ error }, 'Error during Redis idempotency key cleanup');
    }
  }

  logger.info({ olderThanMs, prunedCount }, 'Cleanup completed');
  return { prunedCount };
}
