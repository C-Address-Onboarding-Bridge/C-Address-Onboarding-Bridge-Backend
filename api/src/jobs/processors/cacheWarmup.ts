import { Job } from 'bullmq';
import { CacheWarmupData } from '../queue';
import { sorobanService } from '../../services/soroban';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const WARMUP_AMOUNT = '1000000';
const WARMUP_ADDRESS = 'GABCDE2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export async function processCacheWarmup(job: Job<CacheWarmupData>): Promise<void> {
  const { assets } = job.data;
  logger.info({ assets }, 'warming up quote cache');

  await Promise.allSettled(
    assets.map((asset) =>
      sorobanService.getQuote(asset, WARMUP_AMOUNT, WARMUP_ADDRESS).catch((err) => {
        logger.warn({ asset, err }, 'cache warmup failed for asset');
      }),
    ),
  );

  logger.info({ assets }, 'cache warmup complete');
}
