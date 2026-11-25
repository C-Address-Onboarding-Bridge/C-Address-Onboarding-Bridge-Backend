import { Router, Request, Response } from 'express';
import { verifyMoonpayWebhook, verifyTransakWebhook } from '../middleware/webhookVerification';
import { logger } from '../logger';
import { getPool } from '../services/db';

// Ordering of statuses so a late or replayed event can never move an order
// backwards (e.g. a late PROCESSING landing after COMPLETED). Unknown
// statuses are treated as rank 0 (never allowed to override anything).
const STATUS_RANK: Record<string, number> = {
  pending: 1,
  processing: 1,
  completed: 2,
  success: 2,
  failed: 2,
  cancelled: 2,
};

function rankOf(status: string | undefined): number {
  if (!status) return 0;
  return STATUS_RANK[status.toLowerCase()] ?? 0;
}

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
    // Transak uses `walletAddress` / `partnerCustomerId`; Moonpay uses
    // `walletAddress` / `userId`. Map both instead of the previous
    // `x || x` no-op, which never picked up the Transak field names.
    const walletAddress = data?.walletAddress;
    const userId = data?.userId || data?.partnerCustomerId;
    const completedAt = (status === 'completed' || status === 'success') ? now : null;
    const newRank = rankOf(status);
    // Inline rank mapping for the EXISTING row's status, so we don't need a
    // schema migration to add a status_rank column: an event only overwrites
    // the row when its rank is >= the currently stored status's rank.
    const existingRankSql = `
      CASE lower(provider_orders.status)
        WHEN 'pending' THEN 1 WHEN 'processing' THEN 1
        WHEN 'completed' THEN 2 WHEN 'success' THEN 2
        WHEN 'failed' THEN 2 WHEN 'cancelled' THEN 2
        ELSE 0
      END`;

    await pool.query(
      `INSERT INTO provider_orders (id, provider, status, amount, currency, wallet_address, user_id, created_at, updated_at, completed_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         status = CASE WHEN $12 >= (${existingRankSql}) THEN $3 ELSE provider_orders.status END,
         updated_at = CASE WHEN $12 >= (${existingRankSql}) THEN $9 ELSE provider_orders.updated_at END,
         completed_at = CASE WHEN $12 >= (${existingRankSql}) THEN COALESCE($10, provider_orders.completed_at) ELSE provider_orders.completed_at END,
         payload = CASE WHEN $12 >= (${existingRankSql}) THEN $11 ELSE provider_orders.payload END`,
      [id, provider, status, amount, currency, walletAddress, userId, now, now, completedAt, JSON.stringify(payload), newRank],
    );
  } catch (err) {
    logger.error({ err, provider, id }, 'failed to save provider order');
  }
}

export const moonpayWebhookRouter = Router();
export const transakWebhookRouter = Router();

function parseWebhookBody(req: Request): Record<string, unknown> | null {
  if (!req.body) return {};
  if (typeof req.body !== 'string') return req.body as Record<string, unknown>;
  try {
    return JSON.parse(req.body);
  } catch {
    return null;
  }
}

moonpayWebhookRouter.post('/', verifyMoonpayWebhook, async (req: Request, res: Response) => {
  logger.info({ path: req.path }, 'moonpay webhook received and verified');
  const body = parseWebhookBody(req);
  if (body === null) {
    // Malformed body: return 400, not 500, so the provider doesn't retry a
    // poison message forever.
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  try {
    const data = body?.data as Record<string, unknown> | undefined;
    const orderId = data?.id as string | undefined;
    const status = data?.status as string | undefined;

    if (orderId && status) {
      await saveProviderOrder('moonpay', orderId, status, body);
    }
    res.json({ status: 'ok' });
  } catch (err) {
    logger.error({ err }, 'moonpay webhook processing error');
    res.status(500).json({ error: 'internal_error' });
  }
});

transakWebhookRouter.post('/', verifyTransakWebhook, async (req: Request, res: Response) => {
  logger.info({ path: req.path }, 'transak webhook received and verified');
  const body = parseWebhookBody(req);
  if (body === null) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  try {
    const data = body?.data as Record<string, unknown> | undefined;
    const orderId = data?.id as string | undefined;
    const status = data?.status as string | undefined;

    if (orderId && status) {
      await saveProviderOrder('transak', orderId, status, body);
    }
    res.json({ status: 'ok' });
  } catch (err) {
    logger.error({ err }, 'transak webhook processing error');
    res.status(500).json({ error: 'internal_error' });
  }
});
