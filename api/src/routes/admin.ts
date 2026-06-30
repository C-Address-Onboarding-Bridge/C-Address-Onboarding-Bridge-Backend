import { Router, Request, Response } from 'express';
import { requireScopes } from '../middleware/rbacAuth';
import {
  getAdminAuditLog,
  getFeeConfig,
  getHealthSnapshot,
  getTransactionStats,
  recordAdminAction,
  updateFeeConfig,
  withdrawAccumulatedFees,
} from '../services/transactions';
import { AuditEventType, integrityAuditLog } from '../services/auditLog';
import { enqueueAudit } from '../services/asyncPipeline';

export const adminRouter = Router();

adminRouter.get('/stats', requireScopes('admin:keys'), (_req: Request, res: Response) => {
  res.json(getTransactionStats());
});

adminRouter.get('/fees', requireScopes('admin:keys'), (_req: Request, res: Response) => {
  res.json(getFeeConfig());
});

adminRouter.post('/fees', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const feeBps = Number.parseInt(String(req.body?.feeBps ?? ''), 10);
  const timelockMs = Number.parseInt(String(req.body?.timelockMs ?? '60000'), 10);
  if (Number.isNaN(feeBps)) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }

  const result = updateFeeConfig(feeBps, timelockMs);
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

adminRouter.post('/fees/withdraw', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const result = withdrawAccumulatedFees();
  const actor = req.apiKeyRecord?.id ?? 'admin';

  recordAdminAction('withdraw_fees', { ...result }, actor);

  const auditPayload = { amount: result.withdrawn, recipient: actor, status: result.status };
  enqueueAudit(
    'fee_withdrawal',
    auditPayload,
    actor,
    () => integrityAuditLog.append('fee_withdrawal', auditPayload, actor),
  );

  res.json(result);
});

adminRouter.get('/health', requireScopes('admin:keys'), (_req: Request, res: Response) => {
  res.json(getHealthSnapshot());
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
