import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sorobanService } from '../services/soroban';
import { explorerService } from '../services/explorer';
import { cacheGet, cacheSet, cacheDel } from '../services/cache';
import { config } from '../config';

export const statusRouter = Router();

export const STATUS_CACHE_PREFIX = 'status:';

const statusSchema = z.object({
  txHash: z.string().regex(/^[a-f0-9]{64}$/, 'invalid transaction hash'),
});

statusRouter.get('/:txHash', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { txHash } = statusSchema.parse(req.params);
    const cacheKey = `${STATUS_CACHE_PREFIX}${txHash}`;

    const cached = await cacheGet(cacheKey);
    if (cached !== null) {
      res.setHeader('X-Cache', 'HIT');
      res.json(JSON.parse(cached));
      return;
    }

    req.log?.debug({ txHash }, 'status cache miss');
    const status = await sorobanService.getTransactionStatus(txHash);
    const body = {
      ...status,
      explorerUrl: explorerService.txUrl(txHash),
      explorerUrls: explorerService.txUrlWithFallbacks(txHash),
    };

    await cacheSet(cacheKey, JSON.stringify(body), config.redis.statusTtlSeconds);
    res.setHeader('X-Cache', 'MISS');
    res.json(body);
  } catch (err) {
    next(err);
  }
});

export async function invalidateStatusCache(txHash: string): Promise<void> {
  await cacheDel(`${STATUS_CACHE_PREFIX}${txHash}`);
}
