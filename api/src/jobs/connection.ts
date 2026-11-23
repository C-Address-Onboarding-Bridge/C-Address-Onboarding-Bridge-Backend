/**
 * Shared BullMQ Redis connection factories.
 *
 * #1051: BullMQ used to build connections from a hand-rolled URL parser that
 * dropped `rediss://` (TLS), the Redis 6 ACL username, and reset the db.
 * Every other Redis client in the API (`services/cache.ts`,
 * `middleware/redisRateLimitStore.ts`) simply passes `config.redis.url` to
 * `new Redis(...)` and therefore works against TLS-only ElastiCache.
 *
 * #1052: producer connections (Queue) must fail fast when Redis is down so
 * callers can take their synchronous fallback instead of parking in
 * ioredis's offline queue. Worker connections, by contrast, need to survive
 * reconnections and keep `maxRetriesPerRequest: null`.
 */
import IORedis, { type RedisOptions } from 'ioredis';
import { config } from '../config';

const BASE_OPTIONS: RedisOptions = {
  // BullMQ requires this to be null on Worker connections so that blocking
  // commands (BRPOPLPUSH) can wait through reconnections instead of failing.
  maxRetriesPerRequest: null,
};

/**
 * Worker-facing connection.
 *
 * Passes the URL straight to ioredis so `rediss://`, `user:pass@`, and the
 * `/db` suffix are handled by ioredis' own URL parser. Keeps the default
 * `enableOfflineQueue: true` so Worker blocking commands survive reconnects.
 *
 * A fresh instance is returned on every call so callers can hand it to
 * multiple BullMQ components without accidentally sharing blocking state.
 */
export function createRedisConnection(overrides: RedisOptions = {}): IORedis {
  return new IORedis(config.redis.url, { ...BASE_OPTIONS, ...overrides });
}

/**
 * Producer-facing connection (used by `Queue`).
 *
 * #1052: `enableOfflineQueue: false` makes commands fail immediately when
 * the connection is not ready, so `Queue.add()` rejects in a fraction of a
 * second instead of hanging in ioredis' offline queue. That is what allows
 * `enqueueAudit` / `enqueueFundingMetrics` in `services/asyncPipeline.ts`
 * to take their synchronous fallback within a bounded time.
 *
 * `maxRetriesPerRequest` is still `null` because BullMQ reads it as a signal
 * that "this connection is owned by BullMQ"; BullMQ itself configures its
 * own retry behaviour on top.
 */
export function createProducerRedisConnection(overrides: RedisOptions = {}): IORedis {
  return new IORedis(config.redis.url, {
    ...BASE_OPTIONS,
    enableOfflineQueue: false,
    ...overrides,
  });
}
