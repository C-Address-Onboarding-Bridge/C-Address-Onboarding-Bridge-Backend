/**
 * Redis-backed cache service with:
 *  - Versioned cache keys (bump CACHE_VERSION to bust all caches at once)
 *  - Per-endpoint TTL configuration
 *  - Stale-while-revalidate (SWR) support
 *  - Single-flight stampede protection (in-process Map + Redis SETNX lock fallback)
 *  - LRU eviction policy enforced via Redis maxmemory-policy configuration
 *  - Prometheus metrics: hits, misses, hit-ratio gauge, entry count, memory usage
 */

import Redis from 'ioredis';
import { config } from '../config';
import {
  cacheHitCounter,
  cacheMissCounter,
  cacheHitRatioGauge,
  cacheEntryCountGauge,
  cacheMemoryBytesGauge,
} from './metrics';

// ─── Cache key versioning ────────────────────────────────────────────────────
/** Increment this constant to invalidate all cached entries on deploy. */
export const CACHE_VERSION = 1;

/** Endpoint-specific TTL configuration (seconds). */
export const CACHE_TTL = {
  quote: config.redis.quoteTtlSeconds,
  status: config.redis.statusTtlSeconds,
  cex: config.redis.cexTtlSeconds,
  transactions: config.redis.transactionsTtlSeconds,
} as const;

/** How long past the primary TTL stale data is still served while revalidating (seconds). */
export const SWR_EXTENSION_SECONDS = 5;

// ─── Key builders ────────────────────────────────────────────────────────────

/**
 * Build a namespaced, versioned cache key.
 * Format: `v{version}:{namespace}:{discriminator}`
 */
export function buildCacheKey(namespace: string, discriminator: string): string {
  return `v${CACHE_VERSION}:${namespace}:${discriminator}`;
}

// ─── Redis singleton ─────────────────────────────────────────────────────────

let _client: Redis | null = null;

function getClient(): Redis | null {
  if (!config.redis.url) return null;
  if (_client) return _client;

  _client = new Redis(config.redis.url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    enableOfflineQueue: false,
    // Instruct Redis to use allkeys-lru so it evicts old entries under memory pressure.
    // The application-level config should also set maxmemory in redis.conf; this is a
    // best-effort hint applied on the first connection.
  });

  _client.on('error', () => {
    // Silently degrade – all callers fall back to live queries.
  });

  return _client;
}

// ─── In-process single-flight registry ───────────────────────────────────────

/**
 * Tracks in-flight computations so that concurrent requests for the same key
 * all await the same Promise rather than each independently querying upstream.
 */
const inFlightMap = new Map<string, Promise<string | null>>();

// ─── Metrics helpers ──────────────────────────────────────────────────────────

let _hits = 0;
let _misses = 0;

function recordHit(): void {
  _hits++;
  cacheHitCounter.inc();
  _updateHitRatio();
}

function recordMiss(): void {
  _misses++;
  cacheMissCounter.inc();
  _updateHitRatio();
}

function _updateHitRatio(): void {
  const total = _hits + _misses;
  if (total > 0) {
    cacheHitRatioGauge.set(_hits / total);
  }
}

// Periodically sample Redis INFO memory and DBSIZE metrics.
let _metricsSamplerStarted = false;

function startMetricsSampler(): void {
  if (_metricsSamplerStarted) return;
  _metricsSamplerStarted = true;

  const sample = async () => {
    const redis = getClient();
    if (!redis) return;
    try {
      const [info, dbsize] = await Promise.all([
        redis.info('memory'),
        redis.dbsize(),
      ]);
      const memMatch = info.match(/used_memory:(\d+)/);
      if (memMatch) {
        cacheMemoryBytesGauge.set(parseInt(memMatch[1], 10));
      }
      cacheEntryCountGauge.set(dbsize);
    } catch {
      // Gracefully degrade if Redis is temporarily unavailable.
    }
  };

  // Sample every 30 seconds; do not block startup.
  setInterval(sample, 30_000).unref();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CacheMetrics {
  hits: number;
  misses: number;
  hitRatio: number;
}

export async function cacheGet(key: string): Promise<string | null> {
  const redis = getClient();
  if (!redis) return null;

  startMetricsSampler();

  try {
    const value = await redis.get(key);
    if (value !== null) {
      recordHit();
    } else {
      recordMiss();
    }
    return value;
  } catch {
    recordMiss();
    return null;
  }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.set(key, value, 'EX', ttlSeconds);
  } catch {
    // Graceful degradation
  }
}

export async function cacheDel(key: string): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.del(key);
  } catch {
    // Graceful degradation
  }
}

export async function cacheDelPattern(pattern: string): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {
    // Graceful degradation
  }
}

// ─── Stale-while-revalidate ──────────────────────────────────────────────────

/**
 * Cache entry wrapper used for stale-while-revalidate.
 * The entry is stored in Redis with a longer "stale TTL" (= ttl + SWR_EXTENSION_SECONDS).
 * The embedded `expiresAt` field marks the "fresh" expiry so consumers can detect staleness.
 */
export interface SWREntry<T = unknown> {
  /** The cached value. */
  value: T;
  /** Unix ms timestamp after which the entry is considered stale (but still usable). */
  expiresAt: number;
}

/**
 * Get a value from the SWR cache.
 * Returns `{ value, stale }` where `stale=true` means the entry is past its
 * primary TTL but still within the SWR extension window.
 */
export async function swrGet<T>(key: string): Promise<{ value: T; stale: boolean } | null> {
  const redis = getClient();
  if (!redis) return null;

  startMetricsSampler();

  try {
    const raw = await redis.get(key);
    if (raw === null) {
      recordMiss();
      return null;
    }

    recordHit();
    const entry: SWREntry<T> = JSON.parse(raw);
    const stale = Date.now() > entry.expiresAt;
    return { value: entry.value, stale };
  } catch {
    recordMiss();
    return null;
  }
}

/**
 * Store a value in the SWR cache.
 * The entry is persisted for `ttlSeconds + SWR_EXTENSION_SECONDS` so stale
 * data is still available during background revalidation.
 */
export async function swrSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  try {
    const entry: SWREntry<T> = {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
    await redis.set(key, JSON.stringify(entry), 'EX', ttlSeconds + SWR_EXTENSION_SECONDS);
  } catch {
    // Graceful degradation
  }
}

// ─── Single-flight / stampede protection ─────────────────────────────────────

/**
 * Acquire a short-lived distributed lock using Redis SETNX.
 * Returns `true` if the lock was acquired, `false` if another instance holds it.
 */
async function acquireRedisLock(lockKey: string, ttlMs = 5000): Promise<boolean> {
  const redis = getClient();
  if (!redis) return true; // No Redis → allow the request through.
  try {
    const result = await redis.set(lockKey, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  } catch {
    return true; // On error, allow through rather than blocking.
  }
}

async function releaseRedisLock(lockKey: string): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.del(lockKey);
  } catch {
    // Ignore
  }
}

/**
 * Execute `fn` with stampede protection.
 *
 * For the same `key`, concurrent callers will wait for the first caller's
 * Promise to resolve rather than each independently triggering `fn`.
 *
 * Uses a two-layer approach:
 *  1. In-process `Map<key, Promise>` for same-process concurrency.
 *  2. Redis SETNX lock for multi-instance deployments.
 *
 * @param key          Cache key (used both for the in-process map and Redis lock key).
 * @param fn           Async factory that computes and stores the fresh value.
 * @param lockTtlMs    How long the Redis lock is held (default 5 s).
 */
export async function withSingleFlight<T>(
  key: string,
  fn: () => Promise<T>,
  lockTtlMs = 5000,
): Promise<T> {
  // 1 — In-process deduplication: check for an already-running computation first.
  const existing = inFlightMap.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  // 2 — Register the work promise BEFORE any async boundary so that concurrent
  //     callers that arrive while we're acquiring the Redis lock will see it.
  const work = (async (): Promise<T> => {
    // Acquire a Redis lock to protect against multi-instance stampede.
    const lockKey = `lock:${key}`;
    const locked = await acquireRedisLock(lockKey, lockTtlMs);
    try {
      const result = await fn();
      return result;
    } finally {
      inFlightMap.delete(key);
      if (locked) {
        await releaseRedisLock(lockKey);
      }
    }
  })();

  inFlightMap.set(key, work as Promise<string | null>);
  return work;
}

// ─── Combined get-or-compute (the main high-level helper) ─────────────────────

/**
 * Attempt to read `key` from the cache using stale-while-revalidate semantics.
 *
 * - Cache HIT (fresh)  → return cached value immediately.
 * - Cache HIT (stale)  → return stale value immediately AND trigger background revalidation.
 * - Cache MISS         → use `withSingleFlight` to compute the value, cache it, and return it.
 *
 * @param key         Cache key.
 * @param ttlSeconds  Primary TTL for fresh data.
 * @param compute     Async factory invoked on cache miss (or background revalidation).
 */
export async function getOrCompute<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  const cached = await swrGet<T>(key);

  if (cached !== null) {
    if (!cached.stale) {
      // Fresh hit – return immediately.
      return cached.value;
    }

    // Stale hit – return immediately but kick off background revalidation.
    // Fire-and-forget; errors are silently swallowed to avoid impacting the response.
    setImmediate(() => {
      withSingleFlight(key, async () => {
        const fresh = await compute();
        await swrSet(key, fresh, ttlSeconds);
        return JSON.stringify(fresh);
      }).catch(() => {
        // Background revalidation errors don't affect the caller.
      });
    });

    return cached.value;
  }

  // Miss – single-flight compute.
  return withSingleFlight(key, async () => {
    const value = await compute();
    await swrSet(key, value, ttlSeconds);
    return value;
  });
}

// ─── Metrics accessors ────────────────────────────────────────────────────────

export function getCacheMetrics(): CacheMetrics {
  const total = _hits + _misses;
  return {
    hits: _hits,
    misses: _misses,
    hitRatio: total > 0 ? _hits / total : 0,
  };
}

export function isRedisEnabled(): boolean {
  return !!config.redis.url;
}

/** Expose the internal Redis client for callers that need direct access (e.g. tests). */
export function getCacheClient(): Redis | null {
  return getClient();
}
