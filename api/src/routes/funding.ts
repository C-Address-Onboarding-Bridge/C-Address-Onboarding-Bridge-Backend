import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { STELLAR_ADDRESS_REGEX, C_ADDRESS_REGEX } from '../utils/constants';
import { sorobanService } from '../services/soroban';
import { explorerService } from '../services/explorer';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { hashPayload, integrityAuditLog } from '../services/auditLog';
import { fundEndpointRateLimit, fundAbuseDetectionMiddleware } from '../middleware/rateLimit';
import { recordFundingMetrics } from '../services/metrics';
import { XdrValidationError, checkSize } from '../services/xdrValidator';
import { enqueueAudit, enqueueFundingMetrics } from '../services/asyncPipeline';
import { requireScopes } from '../middleware/rbac';
import { PermissionScope } from '../types/auth';

/** Express router for funding endpoints. Mounted at `/api/v1/fund`. */
export const fundingRouter = Router();

fundingRouter.use(fundAbuseDetectionMiddleware);
fundingRouter.use(requireScopes(PermissionScope.FUND_WRITE));

// ── Status mapping ────────────────────────────────────────────────────────────
//
// #845: Only `pending`/`success` submissions are a 201 Created. A rejected
// transaction (`failed`) maps to 422 and an expired one to 410 so clients that
// branch on the HTTP status do not treat a rejected transaction as created.

function submissionHttpStatus(status: string): number {
  switch (status) {
    case 'pending':
    case 'success':
      return 201;
    case 'failed':
      return 422;
    case 'expired':
      return 410;
    default:
      return 201;
  }
}

// ── Schemas ────────────────────────────────────────────────────────────────────

const fundSchema = z.object({
  // Size is checked with checkSize() so oversized XDR returns XDR_TOO_LARGE.
  signedXdr: z.string().min(1, 'signed transaction XDR is required'),
});

const fundPrepareSchema = z.object({
  sourceAddress: z.string().regex(STELLAR_ADDRESS_REGEX, 'invalid source Stellar address'),
  targetAddress: z.string().regex(C_ADDRESS_REGEX, 'invalid target C-address'),
  tokenAddress: z.string().regex(C_ADDRESS_REGEX, 'invalid token contract address'),
  amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
  memo: z.string().max(64).default(''),
});

const fundDirectSchema = z.object({
  sourceAddress: z.string().regex(STELLAR_ADDRESS_REGEX, 'invalid source Stellar address'),
  targetAddress: z.string().regex(C_ADDRESS_REGEX, 'invalid target C-address'),
  tokenAddress: z.string().regex(C_ADDRESS_REGEX, 'invalid token contract address'),
  amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
  memo: z.string().max(64).default(''),
});

const batchFundSchema = z.object({
  // Size is checked with checkSize() so oversized XDR returns XDR_TOO_LARGE.
  signedXdr: z.string().min(1, 'signed transaction XDR is required'),
  recipients: z.array(
    z.object({
      target: z.string().regex(C_ADDRESS_REGEX, 'invalid target C-address'),
      amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
      tokenAddress: z.string().regex(C_ADDRESS_REGEX, 'invalid token contract address').optional(),
    }),
  ).min(1, 'at least one recipient is required').max(100, 'maximum 100 recipients per batch'),
});

// ── POST /prepare ─────────────────────────────────────────────────────────────
//
// #634: Simulates only — must NOT emit funding metrics or a
// `transaction_submission` audit event.  Emits `transaction_prepared` instead.

fundingRouter.post('/prepare', fundEndpointRateLimit, idempotencyMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    req.log?.info({ path: req.path }, 'fund prepare simulation started');
    const body = fundPrepareSchema.parse(req.body);

    const prepared = await sorobanService.prepareFundingTransaction(
      body.sourceAddress,
      body.targetAddress,
      body.tokenAddress,
      body.amount,
      body.memo,
    );

    const actor = req.apiKeyRecord?.id ?? 'api-key';

    // #634: emit `transaction_prepared` — NOT `transaction_submission_result`.
    // No funding metrics are recorded because no transaction was submitted.
    enqueueAudit(
      'transaction_prepared',
      {
        sourceAddress: body.sourceAddress,
        targetAddress: body.targetAddress,
        tokenAddress: body.tokenAddress,
        amount: body.amount,
        fee: prepared.fee,
      },
      actor,
      () => integrityAuditLog.append(
        'transaction_prepared',
        {
          sourceAddress: body.sourceAddress,
          targetAddress: body.targetAddress,
          tokenAddress: body.tokenAddress,
          amount: body.amount,
          fee: prepared.fee,
        },
        actor,
      ),
    );

    req.log?.info({ targetAddress: body.targetAddress, fee: prepared.fee }, 'fund prepare simulation completed');

    res.status(200).json({
      unsignedXdr: prepared.unsignedXdr,
      footprint: prepared.footprint,
      fee: prepared.fee,
      sourceAddress: body.sourceAddress,
      targetAddress: body.targetAddress,
      tokenAddress: body.tokenAddress,
      amount: body.amount,
      memo: body.memo,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST / ────────────────────────────────────────────────────────────────────

fundingRouter.post('/', fundEndpointRateLimit, idempotencyMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    req.log?.info({ path: req.path }, 'fund transaction submission started');
    const body = fundSchema.parse(req.body);
    checkSize(body.signedXdr);
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

    // #845: map submission status to the correct HTTP status code.
    res.status(submissionHttpStatus(result.status)).json({
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

// ── POST /batch ───────────────────────────────────────────────────────────────
//
// #636: Decode the actual recipients from the signed XDR and cross-check them
// against the `recipients` body array.  Reject the request when they differ.
//
// #833: `batch_fund_c_address` takes parallel vectors
// (targets, token_addresses, amounts, memos), so the decoder now returns the
// token per recipient too.  Cross-check it here when the body supplies one.

fundingRouter.post('/batch', fundEndpointRateLimit, idempotencyMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    req.log?.info({ path: req.path }, 'batch fund transaction submission started');
    const body = batchFundSchema.parse(req.body);
    checkSize(body.signedXdr);

    // #636: decode recipients from the XDR so the audit trail is honest.
    const xdrRecipients = sorobanService.decodeRecipientsFromXdr(body.signedXdr);

    if (xdrRecipients === null) {
      res.status(400).json({
        error: 'xdr_decode_failed',
        message: 'Could not decode recipients from signedXdr. Ensure the transaction encodes a batch_fund_c_address call.',
      });
      return;
    }

    // Cross-check XDR recipients against the body to catch any mismatch.
    if (xdrRecipients.length !== body.recipients.length) {
      res.status(400).json({
        error: 'recipient_mismatch',
        message: `Recipient count mismatch: body declares ${body.recipients.length} but signedXdr encodes ${xdrRecipients.length}.`,
      });
      return;
    }

    for (let i = 0; i < body.recipients.length; i++) {
      const bodyR = body.recipients[i];
      const xdrR = xdrRecipients[i];
      if (bodyR.target !== xdrR.target || bodyR.amount !== xdrR.amount) {
        res.status(400).json({
          error: 'recipient_mismatch',
          message: `Recipient ${i} mismatch: body declares target=${bodyR.target} amount=${bodyR.amount} but signedXdr encodes target=${xdrR.target} amount=${xdrR.amount}.`,
        });
        return;
      }
      // #833: cross-check the token per recipient when the body supplies one.
      if (bodyR.tokenAddress !== undefined && bodyR.tokenAddress !== xdrR.tokenAddress) {
        res.status(400).json({
          error: 'recipient_mismatch',
          message: `Recipient ${i} token mismatch: body declares tokenAddress=${bodyR.tokenAddress} but signedXdr encodes tokenAddress=${xdrR.tokenAddress}.`,
        });
        return;
      }
    }

    const result = await sorobanService.submitFundingTransaction(body.signedXdr);

    const actor = req.apiKeyRecord?.id ?? 'api-key';

    enqueueAudit(
      'transaction_submission_result',
      {
        txHash: result.hash,
        status: result.status,
        signedXdrHash: hashPayload(body.signedXdr),
        recipients: xdrRecipients,
        error: result.error,
        recipientCount: body.recipients.length,
      },
      actor,
      () => integrityAuditLog.append(
        'transaction_submission_result',
        {
          txHash: result.hash,
          status: result.status,
          signedXdrHash: hashPayload(body.signedXdr),
          recipients: xdrRecipients,
          error: result.error,
        },
        actor,
      ),
    );

    req.log?.info({ txHash: result.hash, status: result.status }, 'batch fund transaction submitted');

    const metricsInput = { source: 'api' as const, status: result.status, funderId: actor };
    enqueueFundingMetrics(metricsInput, () => recordFundingMetrics(metricsInput));

    // #845: map submission status to the correct HTTP status code.
    res.status(submissionHttpStatus(result.status)).json({
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

// ── POST /direct ──────────────────────────────────────────────────────────────

fundingRouter.post('/direct', fundEndpointRateLimit, idempotencyMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    req.log?.info({ path: req.path }, 'direct fund transaction submission started');
    const body = fundDirectSchema.parse(req.body);

    const result = await sorobanService.submitDirectFunding(
      body.sourceAddress,
      body.targetAddress,
      body.tokenAddress,
      body.amount,
      body.memo,
    );

    const actor = req.apiKeyRecord?.id ?? 'api-key';

    enqueueAudit(
      'transaction_submission_result',
      {
        txHash: result.hash,
        status: result.status,
        sourceAddress: body.sourceAddress,
        targetAddress: body.targetAddress,
        tokenAddress: body.tokenAddress,
        amount: body.amount,
        error: result.error,
      },
      actor,
      () => integrityAuditLog.append(
        'transaction_submission_result',
        {
          txHash: result.hash,
          status: result.status,
          sourceAddress: body.sourceAddress,
          targetAddress: body.targetAddress,
          tokenAddress: body.tokenAddress,
          amount: body.amount,
          error: result.error,
        },
        actor,
      ),
    );

    req.log?.info({ txHash: result.hash, status: result.status }, 'direct fund transaction submitted');

    const metricsInput = { source: 'api' as const, status: result.status, funderId: actor };
    enqueueFundingMetrics(metricsInput, () => recordFundingMetrics(metricsInput));

    // #845: map submission status to the correct HTTP status code.
    res.status(submissionHttpStatus(result.status)).json({
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
