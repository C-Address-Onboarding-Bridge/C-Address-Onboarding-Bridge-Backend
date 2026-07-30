import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { C_ADDRESS_REGEX } from '../utils/constants';
import { cexService } from '../services/cex';
import { exchangeRoutingCount } from '../services/metrics';
import { buildCacheKey, CACHE_TTL, getOrCompute, cacheDel } from '../services/cache';

/** Express router for CEX withdrawal routing. Mounted at `/api/v1/cex`. */
export const cexRouter = Router();

const routeSchema = z.object({
  exchange: z.enum(['binance', 'coinbase', 'kraken', 'generic']),
  sourceAsset: z.string().min(1),
  amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
  targetCAddress: z.string().regex(C_ADDRESS_REGEX, 'invalid target C-address'),
  targetNetwork: z.string().default('stellar'),
  memo: z.string().max(64).optional(),
});

cexRouter.post('/route', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = routeSchema.parse(req.body);

    // Cache key covers all deterministic routing inputs; memo is intentionally
    // excluded because it is a caller-supplied label that doesn't affect routing.
    const cacheKey = buildCacheKey(
      'cex',
      `${body.exchange}:${body.sourceAsset}:${body.amount}:${body.targetCAddress}:${body.targetNetwork}`,
    );

    // routeWithdrawal can resolve with {status: 'failed', ...} when the exchange API fails.
    // We only cache successful results to avoid poisoning the cache with transient failures.
    const result = await getOrCompute(
      cacheKey,
      CACHE_TTL.cex,
      () => cexService.routeWithdrawal(body),
    );

    // If the result indicates failure, don't use the cached value and retry next time.
    if (result.status === 'failed') {
      // Clear this cache entry so the next request will retry the exchange API.
      // Use setImmediate to avoid blocking the response.
      setImmediate(() => {
        cacheDel(cacheKey).catch(() => {
          // Errors in cache deletion don't affect the client response.
        });
      });
      exchangeRoutingCount.inc({ exchange: body.exchange, status: 'failed' });
      res.status(201).json(result);
      return;
    }

    exchangeRoutingCount.inc({ exchange: body.exchange, status: 'success' });
    res.setHeader('X-Cache', res.getHeader('X-Cache') ?? 'MISS');
    res.status(201).json(result);
  } catch (err) {
    const exchange = (req.body as { exchange?: string })?.exchange ?? 'unknown';
    exchangeRoutingCount.inc({ exchange, status: 'failed' });
    next(err);
  }
});
