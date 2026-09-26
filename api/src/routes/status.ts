import { Router, Request, Response } from 'express';
import { requireScopes } from '../middleware/rbac';
import { PermissionScope } from '../types/permissions';
import { getQueueStats } from '../services/queue';

const router = Router();

/**
 * GET /api/v1/status/queues
 * Returns queue depth and processing statistics.
 */
router.get(
  '/queues',
  requireScopes(PermissionScope.STATUS_READ),
  async (_req: Request, res: Response) => {
    try {
      const stats = await getQueueStats();
      res.json({ success: true, data: stats });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Failed to fetch queue stats' });
    }
  }
);

/**
 * GET /api/v1/status/health
 * Lightweight health probe for the status router.
 */
router.get(
  '/health',
  requireScopes(PermissionScope.STATUS_READ),
  (_req: Request, res: Response) => {
    res.json({ success: true, data: { status: 'ok' } });
  }
);

export default router;
