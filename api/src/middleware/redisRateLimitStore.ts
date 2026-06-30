import type { Store, Options, IncrementResponse } from 'express-rate-limit';
import Redis from 'ioredis';
import { config } from '../config';

let redisClient: Redis | null = null;

function getRedis(): Redis | null {
  if (!config.rateLimit.redisEnabled || !config.redis.url) return null;
  if (!redisClient) {
    redisClient = new Redis(config.redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      enableOfflineQueue: false,
    });
    redisClient.on('error', () => {});
  }
  return redisClient;
}

export class RedisRateLimitStore implements Store {
  prefix: string;
  windowMs!: number;
  private readonly redisPrefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
    this.redisPrefix = `rl:${prefix}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const redis = getRedis();
    if (!redis) {
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }

    const redisKey = `${this.redisPrefix}${key}`;
    const ttlSec = Math.ceil(this.windowMs / 1000);

    try {
      const pipeline = redis.multi();
      pipeline.incr(redisKey);
      pipeline.pttl(redisKey);
      const results = await pipeline.exec();
      const totalHits = (results?.[0]?.[1] as number) ?? 1;
      let ttlMs = (results?.[1]?.[1] as number) ?? -1;

      if (ttlMs < 0) {
        await redis.expire(redisKey, ttlSec);
        ttlMs = ttlSec * 1000;
      }

      return {
        totalHits,
        resetTime: new Date(Date.now() + ttlMs),
      };
    } catch {
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
      await redis.decr(`${this.redisPrefix}${key}`);
    } catch { /* degrade gracefully */ }
  }

  async resetKey(key: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
      await redis.del(`${this.redisPrefix}${key}`);
    } catch { /* degrade gracefully */ }
  }
}
