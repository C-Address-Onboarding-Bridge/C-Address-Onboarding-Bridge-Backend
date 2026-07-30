import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
process.env.BRIDGE_FEE_BPS = '30';
process.env.API_KEYS = 'test-api-key-123';

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  json: vi.fn().mockResolvedValue({ id: 'mock-withdrawal-id', txId: 'mock-tx-hash' }),
  text: vi.fn().mockResolvedValue('ok'),
}));

let app: import('express').Express;

beforeAll(async () => {
  const mod = await import('../index');
  app = mod.app;
});

describe('API E2E', () => {
  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    // 200 = fully healthy, 207 = degraded (some deps unreachable in CI). Both are acceptable.
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(['ok', 'degraded']).toContain(res.body.status);
    expect(res.body).toHaveProperty('timestamp');
  });

  it('GET /api/v1/admin/health reflects real circuit breaker state', async () => {
    const { createApiKey } = await import('../middleware/rbacAuth');
    const { rawKey } = createApiKey({ name: 'health-admin', createdBy: 'test', scopes: ['admin:keys'] });

    const res = await request(app)
      .get('/api/v1/admin/health')
      .set('X-API-Key', rawKey);

    // 200 = healthy, 207 = degraded, 503 = unhealthy
    expect([200, 207, 503]).toContain(res.status);

    // Admin health should have the same structure as public health
    expect(res.body).toHaveProperty('status');
    expect(['ok', 'degraded', 'unhealthy']).toContain(res.body.status);
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('dependencies');

    // Admin health should also include circuit breaker state (not in public health)
    expect(res.body).toHaveProperty('circuits');
    expect(res.body.circuits).toHaveProperty('soroban');
    expect(res.body.circuits).toHaveProperty('moonpay');
    expect(res.body.circuits).toHaveProperty('transak');
    expect(res.body.circuits).toHaveProperty('cex');

    // All circuit states should be valid
    const validStates = ['closed', 'open', 'half-open'];
    for (const circuit of Object.values(res.body.circuits)) {
      expect(validStates).toContain(circuit);
    }
  });

  it('accept header versioning routes to v2 when requested', async () => {
    const res = await request(app)
      .get('/api/quote')
      .query({
        sourceAsset: 'XLM',
        amount: '1000',
        targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      })
      .set('X-API-Key', 'test-api-key-123')
      .set('Accept', 'application/vnd.bridge+json; version=2');

    expect(res.status).toBe(200);
    expect(res.headers['x-api-version']).toBe('v2');
  });

  it('v1 endpoints expose deprecation headers', async () => {
    const res = await request(app)
      .get('/api/v1/quote')
      .query({
        sourceAsset: 'XLM',
        amount: '1000',
        targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      })
      .set('X-API-Key', 'test-api-key-123');

    expect(res.status).toBe(200);
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers['x-api-version']).toBe('v1');
  });

  it('GET /api/v1/quote returns fee quote for authed request', async () => {
    const res = await request(app)
      .get('/api/v1/quote')
      .query({
        sourceAsset: 'XLM',
        amount: '1000',
        targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      })
      .set('X-API-Key', 'test-api-key-123');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('estimatedFee');
    expect(res.body).toHaveProperty('expectedReceive');
    expect(res.body.feeBps).toBe(30);
  });

  it('GET /api/v1/quote returns 401 without API key', async () => {
    const res = await request(app)
      .get('/api/v1/quote')
      .query({
        sourceAsset: 'XLM',
        amount: '1000',
        targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('GET /api/v1/quote returns 400 for invalid address', async () => {
    const res = await request(app)
      .get('/api/v1/quote')
      .query({
        sourceAsset: 'XLM',
        amount: '1000',
        targetAddress: 'not-an-address',
      })
      .set('X-API-Key', 'test-api-key-123');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('POST /api/v1/fund returns 400 for invalid XDR', async () => {
    const res = await request(app)
      .post('/api/v1/fund')
      .send({
        signedXdr: 'AAAAAgAAAA...',
      })
      .set('X-API-Key', 'test-api-key-123');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('POST /api/v1/fund returns 400 for missing signedXdr', async () => {
    const res = await request(app)
      .post('/api/v1/fund')
      .send({})
      .set('X-API-Key', 'test-api-key-123');

    expect(res.status).toBe(400);
  });

  it('POST /api/v1/offramp/moonpay generates url', async () => {
    const res = await request(app)
      .post('/api/v1/offramp/moonpay')
      .send({
        walletAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
        walletNetwork: 'stellar',
      })
      .set('X-API-Key', 'test-api-key-123');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('url');
    expect(res.body.url).toContain('buy.moonpay.com');
  });

  it('POST /api/v1/cex/route routes withdrawal', async () => {
    const res = await request(app)
      .post('/api/v1/cex/route')
      .send({
        exchange: 'binance',
        sourceAsset: 'XLM',
        amount: '10000000',
        targetCAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
        targetNetwork: 'stellar',
      })
      .set('X-API-Key', 'test-api-key-123');

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('withdrawalId');
    expect(res.body.withdrawalId).toContain('bin-');
  });

  it('POST /api/v1/cex/route returns 400 for invalid C-address', async () => {
    const res = await request(app)
      .post('/api/v1/cex/route')
      .send({
        exchange: 'binance',
        sourceAsset: 'XLM',
        amount: '10000000',
        targetCAddress: 'bad-address',
        targetNetwork: 'stellar',
      })
      .set('X-API-Key', 'test-api-key-123');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('POST /api/v1/cex/route does not cache failure results', async () => {
    const mockFetch = vi.mocked(global.fetch);
    const body = {
      exchange: 'binance',
      sourceAsset: 'XLM',
      amount: '9999999',
      targetCAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      targetNetwork: 'stellar',
    };

    // First request: exchange API returns 500 (transient failure)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Internal Server Error'),
    } as any);

    const res1 = await request(app)
      .post('/api/v1/cex/route')
      .send(body)
      .set('X-API-Key', 'test-api-key-123');

    expect(res1.status).toBe(201);
    expect(res1.body.status).toBe('failed');

    // Second request (identical): should retry the exchange API, not return cached failure
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ id: 'retry-success', txId: 'tx-hash-retry' }),
    } as any);

    const res2 = await request(app)
      .post('/api/v1/cex/route')
      .send(body)
      .set('X-API-Key', 'test-api-key-123');

    expect(res2.status).toBe(201);
    expect(res2.body.status).toBe('pending');
    expect(res2.body.withdrawalId).toContain('bin-');

    // Verify fetch was called twice (initial failure + retry), not cached
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('GET /api/v1/quote returns identical response on repeated call (cache hit)', async () => {
    const query = {
      sourceAsset: 'XLM',
      amount: '9999',
      targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
    };
    const res1 = await request(app).get('/api/v1/quote').query(query).set('X-API-Key', 'test-api-key-123');
    const res2 = await request(app).get('/api/v1/quote').query(query).set('X-API-Key', 'test-api-key-123');
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body).toEqual(res2.body);
  });

  it('GET /api/v1/status/:txHash returns 400 for invalid hash', async () => {
    const res = await request(app)
      .get('/api/v1/status/short-hash')
      .set('X-API-Key', 'test-api-key-123');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('POST /api/v1/fund/prepare returns simulation', async () => {
    const res = await request(app)
      .post('/api/v1/fund/prepare')
      .send({
        sourceAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
        targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
        tokenAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
        amount: '1000',
        memo: 'test',
      })
      .set('X-API-Key', 'test-api-key-123');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('instruction');
    expect(res.body).toHaveProperty('simulation');
  });
});
