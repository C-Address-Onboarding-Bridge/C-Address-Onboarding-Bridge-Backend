import { Job } from 'bullmq';
import { CacheWarmupData } from '../queue';
import { sorobanService } from '../../services/soroban';
import { buildCacheKey, swrSet, CACHE_TTL } from '../../services/cache';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/** Canonical "probe" amount used for cache warming – 1 XLM in stroops. */
const WARMUP_AMOUNT = '10000000';

/**
 * Placeholder target address used for cache warming.
 * The bridge contract treats this as any other C-address; the warmup quote
 * is purely informational and never submitted as a transaction.
 */
const WARMUP_ADDRESS = 'GABCDE2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export async function processCacheWarmup(job: Job<CacheWarmupData>): Promise<void> {
  const { assets } = job.data;
  logger.debug({ jobId: job.id, assetCount: assets.length }, 'warming up cache');

  const results = await Promise.allSettled(
    assets.map(async (asset) => {
      const quote = await sorobanService.getQuote(asset, WARMUP_AMOUNT, WARMUP_ADDRESS);
      const cacheKey = buildCacheKey('quote', `${asset}:${WARMUP_AMOUNT}:${WARMUP_ADDRESS}`);
      await swrSet(cacheKey, quote, CACHE_TTL.quote);
      logger.debug({ jobId: job.id, asset }, 'cache warmed');
    }),
  );

  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    logger.warn(
      { jobId: job.id, failureCount: failures.length, totalAssets: assets.length },
      'some assets failed to warm',
    );
  }
}
