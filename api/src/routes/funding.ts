import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sorobanService } from '../services/soroban';
import { explorerService } from '../services/explorer';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { hashPayload, integrityAuditLog } from '../services/auditLog';
import { config } from '../config';
import { fundEndpointRateLimit, fundAbuseDetectionMiddleware } from '../middleware/rateLimit';
import { recordFundingMetrics } from '../services/metrics';

/** Express router for funding endpoints. Mounted at `/api/v1/fund`. */
export const fundingRouter = Router();

fundingRouter.use(fundAbuseDetectionMiddleware);

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

fundingRouter.post('/', fundEndpointRateLimit, idempotencyMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    req.log?.info({ path: req.path }, 'fund transaction submission started');
    const body = fundSchema.parse(req.body);
    const result = await sorobanService.submitFundingTransaction(body.signedXdr);
    integrityAuditLog.append('transaction_submission_result', {
      txHash: result.hash,
      status: result.status,
      signedXdrHash: hashPayload(body.signedXdr),
      error: result.error,
    }, req.apiKeyRecord?.id ?? 'api-key');
    req.log?.info({ txHash: result.hash, status: result.status }, 'fund transaction submitted');
    recordFundingMetrics({
      source: 'api',
      status: result.status,
      funderId: req.apiKeyRecord?.id,
    });
    res.status(201).json({
      ...result,
      explorerUrl: explorerService.txUrl(result.hash),
      explorerUrls: explorerService.txUrlWithFallbacks(result.hash),
    });
  } catch (err) {
    next(err);
  }
});

fundingRouter.post('/prepare', fundEndpointRateLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = fundDirectSchema.parse(req.body);
    const feeBps = config.soroban.feeBps;
    const amountNum = BigInt(body.amount);
    const feeAmount = (amountNum * BigInt(feeBps)) / 10000n;
    const simulation = await sorobanService.contractSimulate(
      body.sourceAddress,
      'fund_c_address',
    );
    integrityAuditLog.append('transaction_submission', {
      amount: body.amount,
      feeBps: config.soroban.feeBps,
      source: body.sourceAddress,
      destination: body.targetAddress,
      tokenAddress: body.tokenAddress,
      memoHash: body.memo ? hashPayload(body.memo) : undefined,
    }, req.apiKeyRecord?.id ?? 'api-key');
    recordFundingMetrics({
      source: 'api',
      status: 'pending',
      amountStroops: body.amount,
      feeStroops: feeAmount.toString(),
      currency: 'XLM',
      funderId: req.apiKeyRecord?.id,
    });
    res.json({
      instruction: 'sign the following transaction with your wallet and submit to POST /api/v1/fund',
      simulation,
      params: body,
    });
  } catch (err) {
    next(err);
  }
});
