import { Router, Request, Response } from 'express';
import { verifyMoonpayWebhook, verifyTransakWebhook } from '../middleware/webhookVerification';
import { logger } from '../logger';
import { getPool } from '../services/db';
import { invalidateStatusCache } from './status';

async function saveProviderOrder(
  provider: 'moonpay' | 'transak',
  id: string,
  status: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const pool = getPool();
  if (!pool) {
    logger.warn({ provider, id }, 'no database configured, skipping order persistence');
    return;
  }

  try {
    const now = Date.now();
    const data = payload.data as Record<string, unknown> | undefined;
    const amount = data?.amount || data?.cryptoAmount;
    const currency = data?.currency || data?.cryptoAssetCode;
    const walletAddress = data?.walletAddress || data?.walletAddress;
    const userId = data?.userId || data?.userId;
    const completedAt = (status === 'completed' || status === 'success') ? now : null;

    await pool.query(
      `INSERT INTO provider_orders (id, provider, status, amount, currency, wallet_address, user_id, created_at, updated_at, completed_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         status = $3,
         updated_at = $9,
         completed_at = COALESCE($10, provider_orders.completed_at),
         payload = $11`,
      [id, provider, status, amount, currency, walletAddress, userId, now, now, completedAt, JSON.stringify(payload)],
    );
  } catch (err) {
    logger.error({ err, provider, id }, 'failed to save provider order');
  }
}

export const moonpayWebhookRouter = Router();
export const transakWebhookRouter = Router();

moonpayWebhookRouter.post('/', verifyMoonpayWebhook, async (req: Request, res: Response) => {
  try {
    logger.info({ path: req.path }, 'moonpay webhook received and verified');
    const body = req.body ? JSON.parse(req.body as string) : {};
    const orderId = body?.data?.id;
    const status = body?.data?.status;

    if (orderId) {
      await saveProviderOrder('moonpay', orderId, status, body);
      await invalidateStatusCache(orderId);
    }
    res.json({ status: 'ok' });
  } catch (err) {
    logger.error({ err }, 'moonpay webhook processing error');
    res.status(500).json({ error: 'internal_error' });
  }
});

transakWebhookRouter.post('/', verifyTransakWebhook, async (req: Request, res: Response) => {
  try {
    logger.info({ path: req.path }, 'transak webhook received and verified');
    const body = req.body ? JSON.parse(req.body as string) : {};
    const orderId = body?.data?.id;
    const status = body?.data?.status;

    if (orderId) {
      await saveProviderOrder('transak', orderId, status, body);
      await invalidateStatusCache(orderId);
    }
    res.json({ status: 'ok' });
  } catch (err) {
    logger.error({ err }, 'transak webhook processing error');
    res.status(500).json({ error: 'internal_error' });
  }
});
