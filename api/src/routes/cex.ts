import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { cexService } from '../services/cex';
import { exchangeRoutingCount } from '../services/metrics';
import { buildCacheKey, CACHE_TTL, getOrCompute } from '../services/cache';

/** Express router for CEX withdrawal routing. Mounted at `/api/v1/cex`. */
export const cexRouter = Router();

const stellarAddressRegex = /^[GC][A-Z2-7]{55}$/;

const routeSchema = z.object({
  exchange: z.enum(['binance', 'coinbase', 'kraken', 'generic']),
  sourceAsset: z.string().min(1),
  amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
  targetCAddress: z.string().regex(stellarAddressRegex, 'invalid target C-address'),
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

    const result = await getOrCompute(
      cacheKey,
      CACHE_TTL.cex,
      () => cexService.routeWithdrawal(body),
    );

    exchangeRoutingCount.inc({ exchange: body.exchange, status: 'success' });
    res.setHeader('X-Cache', res.getHeader('X-Cache') ?? 'MISS');
    res.status(201).json(result);
  } catch (err) {
    const exchange = (req.body as { exchange?: string })?.exchange ?? 'unknown';
    exchangeRoutingCount.inc({ exchange, status: 'failed' });
    next(err);
  }
});
