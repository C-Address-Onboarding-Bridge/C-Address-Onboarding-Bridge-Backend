import { Router, Request, Response } from 'express';
import { requireScopes } from '../middleware/rbacAuth';
import {
  CONTRACT_MAX_FEE_BPS,
  getAdminAuditLog,
  getFeeConfig,
  getTransactionStats,
  recordAdminAction,
  updateFeeConfig,
  withdrawAccumulatedFees,
} from '../services/transactions';
import { AuditEventType, integrityAuditLog } from '../services/auditLog';
import { enqueueAudit } from '../services/asyncPipeline';
import { circuitBreakers } from '../index';
import { getHealthStatus } from '../services/health';
import { isRedisEnabled, getCacheMetrics } from '../services/cache';

export const adminRouter = Router();

adminRouter.get('/stats', requireScopes('admin:keys'), async (_req: Request, res: Response) => {
  res.json(await getTransactionStats());
});

adminRouter.get('/fees', requireScopes('admin:keys'), (_req: Request, res: Response) => {
  res.json(getFeeConfig());
});

adminRouter.post('/fees', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const feeBps = Number.parseInt(String(req.body?.feeBps ?? ''), 10);
  const timelockMs = Number.parseInt(String(req.body?.timelockMs ?? '60000'), 10);

  // #639 — validate against contract max_fee_bps (1000 bps), not 10 000
  if (Number.isNaN(feeBps) || feeBps < 0 || feeBps > CONTRACT_MAX_FEE_BPS) {
    res.status(400).json({
      error: 'bad_request',
      message: `feeBps must be an integer in [0, ${CONTRACT_MAX_FEE_BPS}]`,
    });
    return;
  }
  // #639 — validate timelockMs: must be a non-negative integer
  if (Number.isNaN(timelockMs) || timelockMs < 0) {
    res.status(400).json({ error: 'bad_request', message: 'timelockMs must be a non-negative integer' });
    return;
  }

  let result: { pendingFeeBps: number; timelockUntil: number };
  try {
    result = updateFeeConfig(feeBps, timelockMs);
  } catch (err) {
    res.status(400).json({ error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const actor = req.apiKeyRecord?.id ?? 'admin';

  // recordAdminAction is synchronous but lightweight (in-memory push) — keep sync.
  recordAdminAction('fee_update', { feeBps, timelockMs }, actor);

  // Audit log: off the response path; sync fallback ensures durability.
  const auditPayload = { operation: 'fee_change', feeBps, timelockMs, result };
  enqueueAudit(
    'admin_operation',
    auditPayload,
    actor,
    () => integrityAuditLog.append('admin_operation', auditPayload, actor),
  );

  res.json(result);
});

// #640 — replace in-memory zero-out with governance proposal flow
adminRouter.post('/fees/withdraw', requireScopes('admin:keys'), async (req: Request, res: Response) => {
  const actor = req.apiKeyRecord?.id ?? 'admin';
  const recipientAddress = typeof req.body?.recipientAddress === 'string' ? req.body.recipientAddress : undefined;
  const tokenAddress = typeof req.body?.tokenAddress === 'string' ? req.body.tokenAddress : undefined;

  const result = await withdrawAccumulatedFees(recipientAddress, tokenAddress);

  recordAdminAction('withdraw_fees_proposal', { ...result }, actor);

  const auditPayload = { proposalId: result.proposalId, recipient: result.recipient, token: result.token, actor };
  enqueueAudit(
    'fee_withdrawal',
    auditPayload,
    actor,
    () => integrityAuditLog.append('fee_withdrawal', auditPayload, actor),
  );

  res.json(result);
});

adminRouter.get('/health', requireScopes('admin:keys'), async (_req: Request, res: Response) => {
  const circuits: Record<string, string> = {};
  for (const [name, cb] of circuitBreakers) {
    circuits[name] = cb.getState();
  }

  const health = await getHealthStatus();
  const statusCode = health.status === 'unhealthy' ? 503 : health.status === 'degraded' ? 207 : 200;

  res.status(statusCode).json({
    ...health,
    circuits,
    cache: { redis: isRedisEnabled(), metrics: getCacheMetrics() },
  });
});

adminRouter.get('/audit/integrity', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const type = typeof req.query.type === 'string' ? (req.query.type as AuditEventType) : undefined;
  const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;
  const cursor = typeof req.query.cursor === 'string' ? Number.parseInt(req.query.cursor, 10) : undefined;
  res.json({ entries: integrityAuditLog.listEntries({ type, limit, cursor }) });
});

adminRouter.get('/audit/integrity/checkpoints', requireScopes('admin:keys'), (_req: Request, res: Response) => {
  res.json({ checkpoints: integrityAuditLog.listCheckpoints() });
});

adminRouter.post('/audit/integrity/checkpoints', requireScopes('admin:keys'), (_req: Request, res: Response) => {
  const checkpoint = integrityAuditLog.publishCheckpointForLatest();
  if (!checkpoint) {
    res.status(404).json({ error: 'not_found', message: 'no audit entries to checkpoint' });
    return;
  }
  res.status(201).json(checkpoint);
});

adminRouter.get('/audit/integrity/verify', requireScopes('admin:keys'), (_req: Request, res: Response) => {
  const result = integrityAuditLog.verify();
  res.status(result.valid ? 200 : 409).json(result);
});

adminRouter.get('/audit/integrity/export', requireScopes('admin:keys'), (req: Request, res: Response) => {
  if (req.query.format === 'ndjson') {
    res.type('application/x-ndjson').send(integrityAuditLog.exportNdjson());
    return;
  }
  res.json(integrityAuditLog.exportJson());
});

adminRouter.get('/audit', requireScopes('admin:keys'), (_req: Request, res: Response) => {
  res.json({ log: getAdminAuditLog() });
});
