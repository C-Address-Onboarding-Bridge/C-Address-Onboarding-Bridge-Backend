import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sorobanService } from '../services/soroban';
import { cacheGet, cacheSet } from '../services/cache';
import { config } from '../config';

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
    const cacheKey = `quote:${params.sourceAsset}:${params.amount}:${params.targetAddress}`;

    const cached = await cacheGet(cacheKey);
    if (cached !== null) {
      res.setHeader('X-Cache', 'HIT');
      res.json(JSON.parse(cached));
      return;
    }

    req.log?.debug({ cacheKey }, 'quote cache miss');
    const quote = await sorobanService.getQuote(
      params.sourceAsset,
      params.amount,
      params.targetAddress,
    );

    await cacheSet(cacheKey, JSON.stringify(quote), config.redis.quoteTtlSeconds);
    res.setHeader('X-Cache', 'MISS');
    res.json(quote);
  } catch (err) {
    next(err);
  }
});
