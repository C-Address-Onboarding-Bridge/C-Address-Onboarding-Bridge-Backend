import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sorobanService } from '../services/soroban';
import { buildCacheKey, CACHE_TTL, getOrCompute, cacheDelPattern } from '../services/cache';
import { setFeeRateBps } from '../services/metrics';

/** Express router for quote endpoints. Mounted at `/api/v1/quote`. */
export const quoteRouter = Router();

const stellarAddressRegex = /^[GC][A-Z2-7]{55}$/;

const getQuoteSchema = z.object({
  sourceAsset: z.string().min(1),
  amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
  targetAddress: z.string().regex(stellarAddressRegex, 'invalid target Stellar address'),
});

quoteRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = getQuoteSchema.parse(req.query);
    const cacheKey = buildCacheKey(
      'quote',
      `${params.sourceAsset}:${params.amount}:${params.targetAddress}`,
    );

    const quote = await getOrCompute(
      cacheKey,
      CACHE_TTL.quote,
      () => sorobanService.getQuote(params.sourceAsset, params.amount, params.targetAddress),
    );

    setFeeRateBps(quote.feeBps);

    // X-Cache header is set inside getOrCompute via SWR logic; signal the outcome here.
    res.setHeader('X-Cache', res.getHeader('X-Cache') ?? 'MISS');
    res.json(quote);
  } catch (err) {
    next(err);
  }
});

/**
 * Invalidate all quote cache entries for a given asset.
 * Called when a new ledger / block is detected.
 */
export async function invalidateQuoteCache(sourceAsset?: string): Promise<void> {
  if (sourceAsset) {
    await cacheDelPattern(`v*:quote:${sourceAsset}:*`);
  } else {
    await cacheDelPattern('v*:quote:*');
  }
}
