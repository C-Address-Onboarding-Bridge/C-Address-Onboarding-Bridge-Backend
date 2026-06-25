import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sorobanService } from '../services/soroban';
import { explorerService } from '../services/explorer';

export const statusRouter = Router();

const statusSchema = z.object({
  txHash: z.string().regex(/^[a-f0-9]{64}$/, 'invalid transaction hash'),
});

statusRouter.get('/:txHash', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { txHash } = statusSchema.parse(req.params);
    const status = await sorobanService.getTransactionStatus(txHash);
    res.json({
      ...status,
      explorerUrl: explorerService.txUrl(txHash),
      explorerUrls: explorerService.txUrlWithFallbacks(txHash),
    });
  } catch (err) {
    next(err);
  }
});
