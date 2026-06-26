import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sorobanService } from '../services/soroban';
import { explorerService } from '../services/explorer';
import { idempotencyMiddleware } from '../middleware/idempotency';

export const fundingRouter = Router();

const stellarAddressRegex = /^[GC][A-Z2-7]{55}$/;
const contractIdRegex = /^[GC][A-Z2-7]{55}$/;

const fundSchema = z.object({
  signedXdr: z.string().min(1, 'signed transaction XDR is required'),
});

const fundDirectSchema = z.object({
  sourceAddress: z.string().regex(stellarAddressRegex, 'invalid source Stellar address'),
  targetAddress: z.string().regex(stellarAddressRegex, 'invalid target C-address'),
  tokenAddress: z.string().regex(contractIdRegex, 'invalid token contract address'),
  amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
  memo: z.string().max(64).default(''),
});

fundingRouter.post('/', idempotencyMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    req.log?.info({ path: req.path }, 'fund transaction submission started');
    const body = fundSchema.parse(req.body);
    const result = await sorobanService.submitFundingTransaction(body.signedXdr);
    req.log?.info({ txHash: result.hash, status: result.status }, 'fund transaction submitted');
    res.status(201).json({
      ...result,
      explorerUrl: explorerService.txUrl(result.hash),
      explorerUrls: explorerService.txUrlWithFallbacks(result.hash),
    });
  } catch (err) {
    next(err);
  }
});

fundingRouter.post('/prepare', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = fundDirectSchema.parse(req.body);
    const simulation = await sorobanService.contractSimulate(
      body.sourceAddress,
      'fund_c_address',
    );
    res.json({
      instruction: 'sign the following transaction with your wallet and submit to POST /api/v1/fund',
      simulation,
      params: body,
    });
  } catch (err) {
    next(err);
  }
});
