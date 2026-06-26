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
  recordAdminAction('fee_update', { feeBps, timelockMs }, req.apiKeyRecord?.id ?? 'admin');
  res.json(result);
});

adminRouter.post('/fees/withdraw', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const result = withdrawAccumulatedFees();
  recordAdminAction('withdraw_fees', { ...result }, req.apiKeyRecord?.id ?? 'admin');
  res.json(result);
});

adminRouter.get('/health', requireScopes('admin:keys'), (_req: Request, res: Response) => {
  res.json(getHealthSnapshot());
});

adminRouter.get('/audit', requireScopes('admin:keys'), (_req: Request, res: Response) => {
  res.json({ log: getAdminAuditLog() });
});
