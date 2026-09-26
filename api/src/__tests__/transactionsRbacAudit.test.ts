import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { rbacAuth, seedLegacyKeys, getAuditLog } from '../middleware/rbacAuth';
import { transactionsRouter } from '../routes/transactions';

process.env.NODE_ENV = 'test';

describe('transactions router rbacAuth auditing (#691)', () => {
  let app: express.Express;
  const rawKey = 'test-tx-audit-key-691';

  beforeEach(() => {
    seedLegacyKeys([rawKey]);
    app = express();
    // Mount router as in api/src/index.ts:189
    app.use('/api/v1/transactions', rbacAuth, transactionsRouter);
  });

  it('records exactly one audit log entry for a single GET /api/v1/transactions request', async () => {
    const initialAuditCount = getAuditLog().filter(
      (entry) => entry.path === '/' || entry.path === '/api/v1/transactions'
    ).length;

    const res = await request(app)
      .get('/api/v1/transactions')
      .set('x-api-key', rawKey);

    expect(res.status).toBe(200);

    const afterAuditCount = getAuditLog().filter(
      (entry) => entry.path === '/' || entry.path === '/api/v1/transactions'
    ).length;

    // Issue #691 defect: rbacAuth was executed twice (once at app.use and once at route handler),
    // resulting in 2 audit log entries for a single request.
    // The expected behavior is exactly 1 audit log entry per request.
    expect(afterAuditCount - initialAuditCount).toBe(1);
  });
});
