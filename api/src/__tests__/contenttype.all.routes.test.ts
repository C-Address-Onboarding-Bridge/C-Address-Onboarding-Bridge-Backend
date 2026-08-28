import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
process.env.BRIDGE_FEE_BPS = '30';
process.env.API_KEYS = 'test-api-key-123';

let app: import('express').Express;

// Mock soroban service
vi.mock('../services/soroban', () => ({
  sorobanService: {
    contractSimulate: vi.fn().mockResolvedValue({
      transactionHash: 'abc123',
      transactionEnvelopeXdr: 'AAAAAgAAAABDrzABL2F/tOvT8T8V++T8KqP1V8DWaFmDVvQJTJTN6w==',
    }),
    submitFundingTransaction: vi.fn(),
  },
}));

// Mock asyncPipeline
vi.mock('../services/asyncPipeline', () => ({
  enqueueAudit: vi.fn(),
  enqueueFundingMetrics: vi.fn(),
}));

// Mock metrics
vi.mock('../services/metrics', async () => {
  const actual = await vi.importActual<typeof import('../services/metrics')>('../services/metrics');
  return {
    ...actual,
    recordFundingMetrics: vi.fn(),
  };
});

beforeAll(async () => {
  const mod = await import('../index');
  app = mod.app;
});

describe('Content-Type enforcement across all API route aliases', () => {
  const validFundRequest = {
    sourceAddress: 'GAHFGQNZXHJJRVCCPQO5J3BSFLSPOZG2JMQVNF5XVLNGSYXHFUQ2EXFD',
    targetAddress: 'CAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    tokenAddress: 'CAKMW7CKBZATWFMKM3LZNGXSDX5KQFMYSVQP2GGKWSJQGBGZVYBZKX4',
    amount: '1000000',
    memo: 'test',
  };

  it('rejects POST /api/v1/fund/prepare with non-JSON content-type', async () => {
    const res = await request(app)
      .post('/api/v1/fund/prepare')
      .set('X-API-Key', 'test-api-key-123')
      .set('Content-Type', 'application/xml')
      .send(validFundRequest);

    expect(res.status).toBe(415);
    expect(res.body.error).toBe('unsupported_media_type');
  });

  it('rejects POST /api/v2/fund/prepare with non-JSON content-type', async () => {
    const res = await request(app)
      .post('/api/v2/fund/prepare')
      .set('X-API-Key', 'test-api-key-123')
      .set('Content-Type', 'application/xml')
      .send(validFundRequest);

    expect(res.status).toBe(415);
    expect(res.body.error).toBe('unsupported_media_type');
  });

  it('rejects POST /api/fund/prepare with non-JSON content-type', async () => {
    const res = await request(app)
      .post('/api/fund/prepare')
      .set('X-API-Key', 'test-api-key-123')
      .set('Content-Type', 'application/xml')
      .send(validFundRequest);

    expect(res.status).toBe(415);
    expect(res.body.error).toBe('unsupported_media_type');
  });

  it('accepts POST /api/v1/fund/prepare with application/json', async () => {
    const res = await request(app)
      .post('/api/v1/fund/prepare')
      .set('X-API-Key', 'test-api-key-123')
      .set('Content-Type', 'application/json')
      .send(validFundRequest);

    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
  });

  it('accepts POST /api/v2/fund/prepare with application/json', async () => {
    const res = await request(app)
      .post('/api/v2/fund/prepare')
      .set('X-API-Key', 'test-api-key-123')
      .set('Content-Type', 'application/json')
      .send(validFundRequest);

    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
  });

  it('accepts POST /api/fund/prepare with application/json', async () => {
    const res = await request(app)
      .post('/api/fund/prepare')
      .set('X-API-Key', 'test-api-key-123')
      .set('Content-Type', 'application/json')
      .send(validFundRequest);

    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
  });

  it('rejects POST /api/v1/fund with non-JSON content-type', async () => {
    const fundRequest = { signedXdr: 'AAAA' };
    const res = await request(app)
      .post('/api/v1/fund')
      .set('X-API-Key', 'test-api-key-123')
      .set('Content-Type', 'text/plain')
      .send(fundRequest);

    expect(res.status).toBe(415);
    expect(res.body.error).toBe('unsupported_media_type');
  });

  it('rejects POST /api/v2/fund with non-JSON content-type', async () => {
    const fundRequest = { signedXdr: 'AAAA' };
    const res = await request(app)
      .post('/api/v2/fund')
      .set('X-API-Key', 'test-api-key-123')
      .set('Content-Type', 'text/plain')
      .send(fundRequest);

    expect(res.status).toBe(415);
    expect(res.body.error).toBe('unsupported_media_type');
  });

  it('rejects POST /api/fund with non-JSON content-type', async () => {
    const fundRequest = { signedXdr: 'AAAA' };
    const res = await request(app)
      .post('/api/fund')
      .set('X-API-Key', 'test-api-key-123')
      .set('Content-Type', 'text/plain')
      .send(fundRequest);

    expect(res.status).toBe(415);
    expect(res.body.error).toBe('unsupported_media_type');
  });
});
