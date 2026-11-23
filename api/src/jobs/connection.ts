/**
 * Shared BullMQ Redis connection factory.
 *
 * #1051: BullMQ used to build connections from a hand-rolled URL parser that
 * dropped `rediss://` (TLS), the Redis 6 ACL username, and reset the db.
 * Every other Redis client in the API (`services/cache.ts`,
 * `middleware/redisRateLimitStore.ts`) simply passes `config.redis.url` to
 * `new Redis(...)` and therefore works against TLS-only ElastiCache.
 *
 * This factory does the same thing for BullMQ: pass the URL straight to
 * ioredis so `rediss://`, `user:pass@`, and the `/db` suffix are all handled
 * by ioredis' own URL parser. `maxRetriesPerRequest: null` is required by
 * BullMQ workers (see BullMQ docs) so blocking commands can survive
 * reconnections.
 */
import IORedis, { type RedisOptions } from 'ioredis';
import { config } from '../config';

/**
 * Build a new ioredis connection suitable for a BullMQ Queue or Worker.
 *
 * A fresh instance is returned on every call so callers can hand it to
 * multiple BullMQ components without accidentally sharing blocking state
 * (BullMQ recommends a dedicated connection per Worker).
 *
 * @param overrides  Optional per-call overrides (e.g. `lazyConnect: true` in tests).
 */
export function createRedisConnection(overrides: RedisOptions = {}): IORedis {
  return new IORedis(config.redis.url, {
    // BullMQ requires this to be null on Worker connections so that blocking
    // commands (BRPOPLPUSH) can wait through reconnections instead of failing.
    maxRetriesPerRequest: null,
    ...overrides,
  });
}
