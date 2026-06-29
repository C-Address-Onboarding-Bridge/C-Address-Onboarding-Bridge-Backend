import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sorobanService } from '../services/soroban';

/** Express router for transaction status endpoints. Mounted at `/api/v1/status`. */
export const statusRouter = Router();

const statusSchema = z.object({
  txHash: z.string().regex(/^[a-f0-9]{64}$/, 'invalid transaction hash'),
});

statusRouter.get('/:txHash', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { txHash } = statusSchema.parse(req.params);
    const status = await sorobanService.getTransactionStatus(txHash);
    res.json(status);
  } catch (err) {
    next(err);
  }
});
