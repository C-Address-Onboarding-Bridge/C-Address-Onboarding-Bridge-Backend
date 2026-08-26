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
  throw new Error('Not implemented: processCacheWarmup');
}
