import { Router, Request, Response } from 'express';
import { getCacheMetrics, isRedisEnabled, getCacheClient } from '../services/cache';

export const cacheMetricsRouter = Router();

/**
 * GET /api/v1/cache/metrics
 *
 * Returns cache statistics:
 *  - hits / misses / hitRatio  (in-process counters)
 *  - entryCount                (Redis DBSIZE)
 *  - memoryBytes               (Redis INFO used_memory)
 *  - redisEnabled              (boolean – false when running without Redis)
 */
cacheMetricsRouter.get('/', async (_req: Request, res: Response) => {
  const base = getCacheMetrics();

  if (!isRedisEnabled()) {
    res.json({
      redisEnabled: false,
      ...base,
      entryCount: 0,
      memoryBytes: 0,
    });
    return;
  }

  const redis = getCacheClient();
  let entryCount = 0;
  let memoryBytes = 0;

  if (redis) {
    try {
      const [info, dbsize] = await Promise.all([redis.info('memory'), redis.dbsize()]);
      entryCount = dbsize;
      const memMatch = info.match(/used_memory:(\d+)/);
      if (memMatch) {
        memoryBytes = parseInt(memMatch[1], 10);
      }
    } catch {
      // Redis temporarily unavailable – return process-level counters only.
    }
  }

  res.json({
    redisEnabled: true,
    ...base,
    entryCount,
    memoryBytes,
  });
});
