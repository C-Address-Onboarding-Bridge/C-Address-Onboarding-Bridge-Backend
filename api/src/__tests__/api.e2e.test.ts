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
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('timestamp');
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

  it('POST /api/v1/fund returns 500 for invalid XDR', async () => {
    const res = await request(app)
      .post('/api/v1/fund')
      .send({
        signedXdr: 'AAAAAgAAAA...',
      })
      .set('X-API-Key', 'test-api-key-123');

    expect(res.status).toBe(500);
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
