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
  logger.info({ assets }, 'warming up quote cache');

  await Promise.allSettled(
    assets.map(async (asset) => {
      try {
        const quote = await sorobanService.getQuote(asset, WARMUP_AMOUNT, WARMUP_ADDRESS);
        const cacheKey = buildCacheKey('quote', `${asset}:${WARMUP_AMOUNT}:${WARMUP_ADDRESS}`);
        await swrSet(cacheKey, quote, CACHE_TTL.quote);
        logger.debug({ asset, cacheKey }, 'cache warmup stored quote');
      } catch (err) {
        logger.warn({ asset, err }, 'cache warmup failed for asset');
      }
    }),
  );

  logger.info({ assets }, 'cache warmup complete');
}
