import { Router, Request, Response } from 'express';
import { rbacAuth } from '../middleware/rbacAuth';
import {
  listTransactions,
  serializeTransactionsCsv,
  type TransactionQueryParams,
  type TransactionStatus,
} from '../services/transactions';
import { buildCacheKey, CACHE_TTL, getOrCompute, cacheDelPattern } from '../services/cache';

export const transactionsRouter = Router();

export const TRANSACTIONS_CACHE_NAMESPACE = 'transactions';

transactionsRouter.get('/', rbacAuth, async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? (req.query.status as TransactionStatus) : undefined;
  const fromDate = typeof req.query.fromDate === 'string' ? req.query.fromDate : undefined;
  const toDate = typeof req.query.toDate === 'string' ? req.query.toDate : undefined;
  const minAmount = typeof req.query.minAmount === 'string' ? req.query.minAmount : undefined;
  const maxAmount = typeof req.query.maxAmount === 'string' ? req.query.maxAmount : undefined;
  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
  const offset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : undefined;
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  const format = typeof req.query.format === 'string' && req.query.format === 'csv' ? 'csv' : 'json';

  const params: TransactionQueryParams = {
    status,
    fromDate,
    toDate,
    minAmount,
    maxAmount,
    limit,
    offset,
    cursor,
    format,
  };

  // CSV responses are not cached (format-specific, likely one-off exports).
  if (format === 'csv') {
    const result = listTransactions(params);
    res.type('text/csv').send(serializeTransactionsCsv(result.data));
    return;
  }

  // Build a stable, deterministic cache key from all query parameters.
  const discriminator = JSON.stringify({ status, fromDate, toDate, minAmount, maxAmount, limit, offset, cursor });
  const cacheKey = buildCacheKey(TRANSACTIONS_CACHE_NAMESPACE, discriminator);

  const result = await getOrCompute(
    cacheKey,
    CACHE_TTL.transactions,
    async () => {
      const r = listTransactions(params);
      return { data: r.data, nextCursor: r.nextCursor, hasMore: r.hasMore };
    },
  );

  res.setHeader('X-Cache', res.getHeader('X-Cache') ?? 'MISS');
  res.json(result);
});

/**
 * Invalidate all transaction list cache entries.
 * Call this whenever a new transaction is recorded.
 */
export async function invalidateTransactionsCache(): Promise<void> {
  await cacheDelPattern(`v*:${TRANSACTIONS_CACHE_NAMESPACE}:*`);
}
