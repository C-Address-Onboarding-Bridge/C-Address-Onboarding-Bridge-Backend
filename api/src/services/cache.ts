import Redis from 'ioredis';
import { config } from '../config';

export interface CacheMetrics {
  hits: number;
  misses: number;
}

const metrics: CacheMetrics = { hits: 0, misses: 0 };

let client: Redis | null = null;

function getClient(): Redis | null {
  if (!config.redis.url) return null;
  if (client) return client;

  client = new Redis(config.redis.url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    enableOfflineQueue: false,
  });

  client.on('error', () => {
    // silently degrade; callers fall back to live queries
  });

  return client;
}

export async function cacheGet(key: string): Promise<string | null> {
  const redis = getClient();
  if (!redis) return null;
  try {
    const value = await redis.get(key);
    if (value !== null) {
      metrics.hits++;
    } else {
      metrics.misses++;
    }
    return value;
  } catch {
    metrics.misses++;
    return null;
  }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.set(key, value, 'EX', ttlSeconds);
  } catch {
    // graceful degradation
  }
}

export async function cacheDel(key: string): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.del(key);
  } catch {
    // graceful degradation
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
    // graceful degradation
  }
}

export function getCacheMetrics(): CacheMetrics {
  return { ...metrics };
}

export function isRedisEnabled(): boolean {
  return !!config.redis.url;
}
