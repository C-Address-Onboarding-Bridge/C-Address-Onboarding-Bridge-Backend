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
import { requireScopes } from '../middleware/rbac';
import { PermissionScope } from '../types/auth';

/** Express router for funding endpoints. Mounted at `/api/v1/fund`. */
export const fundingRouter = Router();

fundingRouter.use(fundAbuseDetectionMiddleware);
fundingRouter.use(requireScopes(PermissionScope.FUND_WRITE));

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

fundingRouter.post('/timelocked/claim', fundEndpointRateLimit, idempotencyMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    req.log?.info({ path: req.path }, 'timelocked claim submission started');
    const body = timelockedClaimSchema.parse(req.body);
    const result = await sorobanService.submitFundingTransaction(body.signedXdr);

    const actor = req.apiKeyRecord?.id ?? 'api-key';

    enqueueAudit(
      'timelocked_claim_submission_result',
      {
        txHash: result.hash,
        status: result.status,
        signedXdrHash: hashPayload(body.signedXdr),
        error: result.error,
      },
      actor,
      () => integrityAuditLog.append(
        'timelocked_claim_submission_result',
        { txHash: result.hash, status: result.status, signedXdrHash: hashPayload(body.signedXdr), error: result.error },
        actor,
      ),
    );

    req.log?.info({ txHash: result.hash, status: result.status }, 'timelocked claim submitted');

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

fundingRouter.post('/direct', fundEndpointRateLimit, idempotencyMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    req.log?.info({ path: req.path }, 'direct fund transaction submission started');
    const body = fundDirectSchema.parse(req.body);
    const result = await sorobanService.submitDirectFunding({
      sourceAddress: body.sourceAddress,
      targetAddress: body.targetAddress,
      tokenAddress: body.tokenAddress,
      amount: body.amount,
      memo: body.memo,
    });

    const actor = req.apiKeyRecord?.id ?? 'api-key';

    enqueueAudit(
      'direct_transaction_submission_result',
      {
        txHash: result.hash,
        status: result.status,
        target: body.targetAddress,
        amount: body.amount,
        error: result.error,
      },
      actor,
      () => integrityAuditLog.append(
        'direct_transaction_submission_result',
        { txHash: result.hash, status: result.status, target: body.targetAddress, amount: body.amount, error: result.error },
        actor,
      ),
    );

    req.log?.info({ txHash: result.hash, status: result.status }, 'direct fund transaction submitted');

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
