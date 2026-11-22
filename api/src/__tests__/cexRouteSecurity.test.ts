import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { cexRouter } from '../routes/cex';
import { rbacAuth, createApiKey } from '../middleware/rbacAuth';
import { cexService } from '../services/cex';

process.env.NODE_ENV = 'test';

const app = express();
app.use(express.json());
app.use(rbacAuth);
app.use('/api/v1/cex', cexRouter);

const validBody = {
  exchange: 'binance',
  sourceAsset: 'XLM',
  amount: '10000000',
  targetCAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
  targetNetwork: 'stellar',
  memo: 'test-memo',
};

describe('/api/v1/cex/route RBAC and Idempotency Security (#881)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('allows a key with cex:withdraw to reach the handler', async () => {
    const { rawKey } = createApiKey({
      name: 'authorized-key',
      createdBy: 'admin',
      scopes: ['cex:withdraw'],
    });

    vi.spyOn(cexService, 'routeWithdrawal').mockResolvedValueOnce({
      status: 'pending',
      withdrawalId: 'bin-12345',
    });

    const res = await request(app)
      .post('/api/v1/cex/route')
      .set('x-api-key', rawKey)
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      status: 'pending',
      withdrawalId: 'bin-12345',
    });
  });

  it('rejects a key without cex:withdraw with 403', async () => {
    const { rawKey } = createApiKey({
      name: 'unauthorized-key',
      createdBy: 'admin',
      scopes: ['cex:read', 'quote:read'],
    });

    const routeSpy = vi.spyOn(cexService, 'routeWithdrawal');

    const res = await request(app)
      .post('/api/v1/cex/route')
      .set('x-api-key', rawKey)
      .send(validBody);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(routeSpy).not.toHaveBeenCalled();
  });

  it('ensures two keys never share an in-flight result', async () => {
    const keyA = createApiKey({
      name: 'tenant-a',
      createdBy: 'admin',
      scopes: ['cex:withdraw'],
    }).rawKey;

    const keyB = createApiKey({
      name: 'tenant-b',
      createdBy: 'admin',
      scopes: ['cex:withdraw'],
    }).rawKey;

    let callCount = 0;
    vi.spyOn(cexService, 'routeWithdrawal').mockImplementation(async () => {
      callCount++;
      const currentCall = callCount;
      // Introduce async delay so both requests are in flight simultaneously
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        status: 'pending',
        withdrawalId: `withdrawal-${currentCall}`,
      };
    });

    // Send identical withdrawal parameters concurrently with two different API keys
    const [resA, resB] = await Promise.all([
      request(app).post('/api/v1/cex/route').set('x-api-key', keyA).send(validBody),
      request(app).post('/api/v1/cex/route').set('x-api-key', keyB).send(validBody),
    ]);

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    // Each tenant must have triggered its own execution and received its own result
    expect(callCount).toBe(2);
    expect(resA.body.withdrawalId).not.toBe(resB.body.withdrawalId);
  });
});
