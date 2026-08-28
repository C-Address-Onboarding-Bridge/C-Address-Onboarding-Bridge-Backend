import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { STELLAR_ADDRESS_REGEX, C_ADDRESS_REGEX } from '../utils/constants';
import { sorobanService } from '../services/soroban';
import { explorerService } from '../services/explorer';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { hashPayload, integrityAuditLog } from '../services/auditLog';
import { config } from '../config';
import { fundEndpointRateLimit, fundAbuseDetectionMiddleware } from '../middleware/rateLimit';
import { recordFundingMetrics } from '../services/metrics';
import { XdrValidationError, MAX_XDR_BYTE_LENGTH } from '../services/xdrValidator';
import { enqueueAudit, enqueueFundingMetrics } from '../services/asyncPipeline';

/** Express router for funding endpoints. Mounted at `/api/v1/fund`. */
export const fundingRouter = Router();

fundingRouter.use(fundAbuseDetectionMiddleware);

const fundSchema = z.object({
  signedXdr: z
    .string()
    .min(1, 'signed transaction XDR is required')
    .max(MAX_XDR_BYTE_LENGTH, `signedXdr must not exceed ${MAX_XDR_BYTE_LENGTH} characters`),
});

const fundDirectSchema = z.object({
  sourceAddress: z.string().regex(STELLAR_ADDRESS_REGEX, 'invalid source Stellar address'),
  targetAddress: z.string().regex(C_ADDRESS_REGEX, 'invalid target C-address'),
  tokenAddress: z.string().regex(C_ADDRESS_REGEX, 'invalid token contract address'),
  amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
  memo: z.string().max(64).default(''),
});

const batchFundSchema = z.object({
  signedXdr: z
    .string()
    .min(1, 'signed transaction XDR is required')
    .max(MAX_XDR_BYTE_LENGTH, `signedXdr must not exceed ${MAX_XDR_BYTE_LENGTH} characters`),
  recipients: z.array(
    z.object({
      target: z.string().regex(C_ADDRESS_REGEX, 'invalid target C-address'),
      amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
    }),
  ).min(1, 'at least one recipient is required').max(100, 'maximum 100 recipients per batch'),
});

const timelockedFundSchema = z.object({
  signedXdr: z
    .string()
    .min(1, 'signed transaction XDR is required')
    .max(MAX_XDR_BYTE_LENGTH, `signedXdr must not exceed ${MAX_XDR_BYTE_LENGTH} characters`),
  targetAddress: z.string().regex(C_ADDRESS_REGEX, 'invalid target C-address'),
  amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
  unlocksAt: z.number().int().positive('unlock time must be a future Unix timestamp'),
});

const timelockedClaimSchema = z.object({
  signedXdr: z
    .string()
    .min(1, 'signed transaction XDR is required')
    .max(MAX_XDR_BYTE_LENGTH, `signedXdr must not exceed ${MAX_XDR_BYTE_LENGTH} characters`),
});

fundingRouter.post('/', fundEndpointRateLimit, idempotencyMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    req.log?.info({ path: req.path }, 'fund transaction submission started');
    const body = fundSchema.parse(req.body);
    const result = await sorobanService.submitFundingTransaction(body.signedXdr);

    const actor = req.apiKeyRecord?.id ?? 'api-key';

    // Audit log: critical — enqueued async but falls back to sync if Redis is down.
    enqueueAudit(
      'transaction_submission_result',
      {
        txHash: result.hash,
        status: result.status,
        signedXdrHash: hashPayload(body.signedXdr),
        error: result.error,
      },
      actor,
      // Sync fallback: run inline when pipeline unavailable.
      () => integrityAuditLog.append(
        'transaction_submission_result',
        { txHash: result.hash, status: result.status, signedXdrHash: hashPayload(body.signedXdr), error: result.error },
        actor,
      ),
    );

    req.log?.info({ txHash: result.hash, status: result.status }, 'fund transaction submitted');

    // Funding metrics: best-effort async, falls back to sync.
    const metricsInput = { source: 'api' as const, status: result.status, funderId: actor };
    enqueueFundingMetrics(metricsInput, () => recordFundingMetrics(metricsInput));

    res.status(201).json({
      ...result,
      explorerUrl: explorerService.txUrl(result.hash),
      explorerUrls: explorerService.txUrlWithFallbacks(result.hash),
    });
  } catch (err) {
    if (err instanceof XdrValidationError) {
      res.status(400).json({ error: err.code, message: err.detail });
      return;
    }
    next(err);
  }
});

fundingRouter.post('/batch', fundEndpointRateLimit, idempotencyMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    req.log?.info({ path: req.path }, 'batch fund transaction submission started');
    const body = batchFundSchema.parse(req.body);
    const result = await sorobanService.submitBatchFundingTransaction(body.signedXdr);

    const actor = req.apiKeyRecord?.id ?? 'api-key';

    // Audit log: critical — enqueued async but falls back to sync if Redis is down.
    enqueueAudit(
      'batch_transaction_submission_result',
      {
        txHash: result.hash,
        status: result.status,
        recipientCount: body.recipients.length,
        signedXdrHash: hashPayload(body.signedXdr),
        error: result.error,
      },
      actor,
      () => integrityAuditLog.append(
        'batch_transaction_submission_result',
        { txHash: result.hash, status: result.status, recipientCount: body.recipients.length, signedXdrHash: hashPayload(body.signedXdr), error: result.error },
        actor,
      ),
    );

    req.log?.info({ txHash: result.hash, status: result.status, recipientCount: body.recipients.length }, 'batch fund transaction submitted');

    // Funding metrics: best-effort async, falls back to sync.
    const metricsInput = { source: 'api' as const, status: result.status, funderId: actor };
    enqueueFundingMetrics(metricsInput, () => recordFundingMetrics(metricsInput));

    res.status(201).json({
      transactionHash: result.hash,
      status: result.status,
      error: result.error,
      recipients: body.recipients.map((r) => ({
        target: r.target,
        amount: r.amount,
        status: result.status,
      })),
      explorerUrl: explorerService.txUrl(result.hash),
      explorerUrls: explorerService.txUrlWithFallbacks(result.hash),
    });
  } catch (err) {
    if (err instanceof XdrValidationError) {
      res.status(400).json({ error: err.code, message: err.detail });
      return;
    }
    next(err);
  }
});

fundingRouter.post('/timelocked', fundEndpointRateLimit, idempotencyMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    req.log?.info({ path: req.path }, 'timelocked fund transaction submission started');
    const body = timelockedFundSchema.parse(req.body);
    const result = await sorobanService.submitFundingTransaction(body.signedXdr);

    const actor = req.apiKeyRecord?.id ?? 'api-key';

    // Audit log: critical — enqueued async but falls back to sync if Redis is down.
    enqueueAudit(
      'timelocked_transaction_submission_result',
      {
        txHash: result.hash,
        status: result.status,
        target: body.targetAddress,
        amount: body.amount,
        unlocksAt: body.unlocksAt,
        signedXdrHash: hashPayload(body.signedXdr),
        error: result.error,
      },
      actor,
      () => integrityAuditLog.append(
        'timelocked_transaction_submission_result',
        { txHash: result.hash, status: result.status, target: body.targetAddress, amount: body.amount, unlocksAt: body.unlocksAt, signedXdrHash: hashPayload(body.signedXdr), error: result.error },
        actor,
      ),
    );

    req.log?.info({ txHash: result.hash, status: result.status }, 'timelocked fund transaction submitted');

    // Funding metrics: best-effort async, falls back to sync.
    const metricsInput = { source: 'api' as const, status: result.status, funderId: actor };
    enqueueFundingMetrics(metricsInput, () => recordFundingMetrics(metricsInput));

    res.status(201).json({
      transactionHash: result.hash,
      status: result.status,
      error: result.error,
      lockId: `${result.hash}-${body.targetAddress}`,
      target: body.targetAddress,
      amount: body.amount,
      unlocksAt: body.unlocksAt,
      timeRemaining: Math.max(0, body.unlocksAt - Math.floor(Date.now() / 1000)),
      explorerUrl: explorerService.txUrl(result.hash),
      explorerUrls: explorerService.txUrlWithFallbacks(result.hash),
    });
  } catch (err) {
    if (err instanceof XdrValidationError) {
      res.status(400).json({ error: err.code, message: err.detail });
      return;
    }
    next(err);
  }
});

fundingRouter.get('/timelocked/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    req.log?.info({ lockId: id }, 'querying timelocked fund state');

    const currentTime = Math.floor(Date.now() / 1000);

    // Parse the lock ID to get transaction hash and target address
    const [txHash, targetAddress] = id.split('-');
    if (!txHash || !targetAddress) {
      res.status(400).json({
        error: 'invalid_lock_id',
        message: 'lock ID must be in format {txHash}-{targetAddress}',
      });
      return;
    }

    const txStatus = await sorobanService.getTransactionStatus(txHash);

    res.json({
      lockId: id,
      target: targetAddress,
      transactionHash: txHash,
      status: txStatus.status,
      isClaimable: false, // In real implementation, check contract state
      timeRemaining: 0, // In real implementation, get from contract
      claimError: txStatus.error,
    });
  } catch (err) {
    next(err);
  }
});

fundingRouter.post('/timelocked/:id/claim', fundEndpointRateLimit, idempotencyMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    req.log?.info({ lockId: id }, 'claiming timelocked fund');

    const body = timelockedClaimSchema.parse(req.body);
    const result = await sorobanService.submitFundingTransaction(body.signedXdr);

    const actor = req.apiKeyRecord?.id ?? 'api-key';

    // Audit log: critical — enqueued async but falls back to sync if Redis is down.
    enqueueAudit(
      'timelocked_claim_result',
      {
        lockId: id,
        txHash: result.hash,
        status: result.status,
        signedXdrHash: hashPayload(body.signedXdr),
        error: result.error,
      },
      actor,
      () => integrityAuditLog.append(
        'timelocked_claim_result',
        { lockId: id, txHash: result.hash, status: result.status, signedXdrHash: hashPayload(body.signedXdr), error: result.error },
        actor,
      ),
    );

    req.log?.info({ lockId: id, txHash: result.hash, status: result.status }, 'timelocked fund claimed');

    // Funding metrics: best-effort async, falls back to sync.
    const metricsInput = { source: 'api' as const, status: result.status, funderId: actor };
    enqueueFundingMetrics(metricsInput, () => recordFundingMetrics(metricsInput));

    res.status(201).json({
      lockId: id,
      claimTransactionHash: result.hash,
      status: result.status,
      error: result.error,
      explorerUrl: explorerService.txUrl(result.hash),
      explorerUrls: explorerService.txUrlWithFallbacks(result.hash),
    });
  } catch (err) {
    if (err instanceof XdrValidationError) {
      res.status(400).json({ error: err.code, message: err.detail });
      return;
    }
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
      body.targetAddress,
      body.tokenAddress,
      body.amount,
      body.memo,
    );

    const actor = req.apiKeyRecord?.id ?? 'api-key';
    const auditPayload = {
      amount: body.amount,
      feeBps: config.soroban.feeBps,
      source: body.sourceAddress,
      destination: body.targetAddress,
      tokenAddress: body.tokenAddress,
      memoHash: body.memo ? hashPayload(body.memo) : undefined,
    };

    // Audit log: critical — async with sync fallback.
    enqueueAudit(
      'transaction_submission',
      auditPayload,
      actor,
      () => integrityAuditLog.append('transaction_submission', auditPayload, actor),
    );

    // Funding metrics: best-effort async with sync fallback.
    const metricsInput = {
      source: 'api' as const,
      status: 'pending' as const,
      amountStroops: body.amount,
      feeStroops: feeAmount.toString(),
      currency: 'XLM',
      funderId: actor,
    };
    enqueueFundingMetrics(metricsInput, () => recordFundingMetrics(metricsInput));

    res.json({
      instruction: 'sign the following transaction with your wallet and submit to POST /api/v1/fund',
      simulation,
      params: body,
    });
  } catch (err) {
    next(err);
  }
});
