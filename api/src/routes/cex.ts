import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { cexService } from '../services/cex';

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
    const result = await cexService.routeWithdrawal(body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
