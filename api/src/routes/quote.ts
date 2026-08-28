import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { STELLAR_ADDRESS_REGEX } from '../utils/constants';
import { sorobanService } from '../services/soroban';
import { buildCacheKey, CACHE_TTL } from '../services/cache';
import { cacheMiddleware } from '../middleware/cache';
import { setFeeRateBps } from '../services/metrics';

/** Express router for quote endpoints. Mounted at `/api/v1/quote`. */
export const quoteRouter = Router();

const getQuoteSchema = z.object({
  sourceAsset: z.string().min(1),
  amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
  targetAddress: z.string().regex(STELLAR_ADDRESS_REGEX, 'invalid target Stellar address'),
});

quoteRouter.get(
  '/',
  cacheMiddleware({
    ttl: CACHE_TTL.quote,
    keyFn: (req) => {
      const params = getQuoteSchema.parse(req.query);
      return buildCacheKey('quote', `${params.sourceAsset}:${params.amount}:${params.targetAddress}`);
    },
  }),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const params = getQuoteSchema.parse(_req.query);
      const quote = await sorobanService.getQuote(
        params.sourceAsset,
        params.amount,
        params.targetAddress,
      );

      setFeeRateBps(quote.feeBps);
      res.json(quote);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Invalidate all quote cache entries for a given asset.
 * Called when a new ledger / block is detected.
 */
export async function invalidateQuoteCache(sourceAsset?: string): Promise<void> {
  if (sourceAsset) {
    await cacheDelPattern(buildCacheKey('quote', `${sourceAsset}:*`));
  } else {
    await cacheDelPattern(buildCacheKey('quote', '*'));
  }
}
