import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sorobanService } from '../services/soroban';

/** Express router for funding endpoints. Mounted at `/api/v1/fund`. */
export const fundingRouter = Router();

const stellarAddressRegex = /^[GC][A-Z2-7]{55}$/;

const fundSchema = z.object({
  signedXdr: z.string().min(1, 'signed transaction XDR is required'),
});

const fundDirectSchema = z.object({
  sourceAddress: z.string().regex(stellarAddressRegex, 'invalid source Stellar address'),
  targetAddress: z.string().regex(stellarAddressRegex, 'invalid target C-address'),
  tokenAddress: z.string().regex(stellarAddressRegex, 'invalid token contract address'),
  amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
  memo: z.string().max(64).default(''),
});

fundingRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = fundSchema.parse(req.body);
    const result = await sorobanService.submitFundingTransaction(body.signedXdr);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

fundingRouter.post('/prepare', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = fundDirectSchema.parse(req.body);
    // TODO: pass all validated fields (targetAddress, tokenAddress, amount, memo) into
    // contractSimulate once the Soroban simulation is fully implemented.
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
