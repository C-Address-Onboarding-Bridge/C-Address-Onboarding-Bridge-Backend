import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sorobanService } from '../services/soroban';
import { explorerService } from '../services/explorer';
import { buildCacheKey, CACHE_TTL, getOrCompute, cacheDel } from '../services/cache';

/** Express router for transaction status endpoints. Mounted at `/api/v1/status`. */
export const statusRouter = Router();

export const STATUS_CACHE_NAMESPACE = 'status';

const statusSchema = z.object({
  txHash: z.string().regex(/^[a-f0-9]{64}$/, 'invalid transaction hash'),
});

statusRouter.get('/:txHash', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { txHash } = statusSchema.parse(req.params);
    const cacheKey = buildCacheKey(STATUS_CACHE_NAMESPACE, txHash);

    const body = await getOrCompute(
      cacheKey,
      CACHE_TTL.status,
      async () => {
        req.log?.debug({ txHash }, 'status cache miss');
        const status = await sorobanService.getTransactionStatus(txHash);
        return {
          ...status,
          explorerUrl: explorerService.txUrl(txHash),
          explorerUrls: explorerService.txUrlWithFallbacks(txHash),
        };
      },
    );

    res.setHeader('X-Cache', res.getHeader('X-Cache') ?? 'MISS');
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * Invalidate the status cache entry for `txHash`.
 * Called by webhook handlers when a transaction status changes.
 */
export async function invalidateStatusCache(txHash: string): Promise<void> {
  const cacheKey = buildCacheKey(STATUS_CACHE_NAMESPACE, txHash);
  await cacheDel(cacheKey);
}
