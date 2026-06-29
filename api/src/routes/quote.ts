import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sorobanService } from '../services/soroban';

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
    const quote = await sorobanService.getQuote(
      params.sourceAsset,
      params.amount,
      params.targetAddress,
    );
    res.json(quote);
  } catch (err) {
    next(err);
  }
});
