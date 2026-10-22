import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';

vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../services/db', () => ({ getPool: () => null }));
vi.mock('../services/transactions', () => ({
  listTransactions: vi.fn(async () => ({ data: [], nextCursor: null, hasMore: false })),
  serializeTransactionsCsv: vi.fn(() => ''),
}));
vi.mock('../services/cache', () => ({
  buildCacheKey: (...parts: string[]) => parts.join(':'),
  CACHE_TTL: { transactions: 30 },
  CACHE_VERSION: 1,
  getOrCompute: async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
  cacheDelPattern: vi.fn(),
}));

import { rbacAuth, createApiKey, getAuditLog } from '../middleware/rbacAuth';
import { transactionsRouter } from '../routes/transactions';

describe('GET /api/v1/transactions authentication (#691)', () => {
  it('authenticates once and writes one audit entry per request', async () => {
    const app = express();
    app.use('/api/v1/transactions', rbacAuth, transactionsRouter);
    const { rawKey, record } = createApiKey({ name: 'tx-reader', createdBy: 'test', scopes: ['transactions:read'] });

    const res = await request(app).get('/api/v1/transactions').set('X-API-Key', rawKey);

    expect(res.status).toBe(200);
    const entries = getAuditLog(0, 10_000).entries.filter((e) => e.keyId === record.id);
    expect(entries).toHaveLength(1);
  });
});
