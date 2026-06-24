import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import NodeCache from 'node-cache';
import { sorobanService } from '../services/soroban';

export const quoteRouter = Router();

const quoteCache = new NodeCache({ stdTTL: 30 });

const stellarAddressRegex = /^[GC][A-Z2-7]{55}$/;

const getQuoteSchema = z.object({
  sourceAsset: z.string().min(1),
  amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
  targetAddress: z.string().regex(stellarAddressRegex, 'invalid target Stellar address'),
});

quoteRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = getQuoteSchema.parse(req.query);
    const cacheKey = `${params.sourceAsset}:${params.amount}:${params.targetAddress}`;
    const cached = quoteCache.get(cacheKey);
    if (cached !== undefined) {
      res.json(cached);
      return;
    }
    const quote = await sorobanService.getQuote(
      params.sourceAsset,
      params.amount,
      params.targetAddress,
    );
    quoteCache.set(cacheKey, quote);
    res.json(quote);
  } catch (err) {
    next(err);
  }
});
