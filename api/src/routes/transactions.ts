import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireScopes } from '../middleware/rbacAuth';
import {
  listTransactions,
  serializeTransactionsCsv,
  type TransactionQueryParams,
} from '../services/transactions';
import { buildCacheKey, CACHE_TTL, CACHE_VERSION, getOrCompute, cacheDelPattern } from '../services/cache';

export const transactionsRouter = Router();

export const TRANSACTIONS_CACHE_NAMESPACE = 'transactions';

const MAX_LIMIT = 100;

const querySchema = z.object({
  status: z.enum(['pending', 'success', 'failed']).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  minAmount: z.string().optional(),
  maxAmount: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
  format: z.enum(['json', 'csv']).optional(),
});

transactionsRouter.get('/', requireScopes('transactions:read'), async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_query', details: parsed.error.issues });
    return;
  }
  const { status, fromDate, toDate, minAmount, maxAmount, limit, offset, cursor, format: rawFormat } = parsed.data;
  const format = rawFormat ?? 'json';

  // Scope results to the caller's own transactions unless they hold the
  // operator-only wide-read scope. Legacy API_KEYS keys only ever get
  // `transactions:read`, so they are always scoped to their own id.
  const callerScopes = req.resolvedScopes ?? [];
  const canReadAll = callerScopes.includes('transactions:read:all');
  const apiKeyId = canReadAll ? undefined : req.apiKeyRecord?.id;

  const params: TransactionQueryParams = {
    status,
    fromDate,
    toDate,
    minAmount,
    maxAmount,
    limit: limit ?? 20,
    offset,
    cursor,
    format,
    apiKeyId,
  };

  // CSV responses are not cached (format-specific, likely one-off exports).
  if (format === 'csv') {
    const result = await listTransactions(params);
    res.type('text/csv').send(serializeTransactionsCsv(result.data));
    return;
  }

  // Build a stable, deterministic cache key from all query parameters,
  // including the caller, so one tenant's cached page can never be served
  // to another.
  const discriminator = JSON.stringify({
    apiKeyId: apiKeyId ?? 'all',
    status,
    fromDate,
    toDate,
    minAmount,
    maxAmount,
    limit: params.limit,
    offset,
    cursor,
  });
  const cacheKey = buildCacheKey(TRANSACTIONS_CACHE_NAMESPACE, discriminator);

  const result = await getOrCompute(
    cacheKey,
    CACHE_TTL.transactions,
    async () => {
      const r = await listTransactions(params);
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
  await cacheDelPattern(`v${CACHE_VERSION}:${TRANSACTIONS_CACHE_NAMESPACE}:*`);
}
