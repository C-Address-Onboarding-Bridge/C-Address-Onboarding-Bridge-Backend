import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
process.env.BRIDGE_FEE_BPS = '30';
process.env.API_KEYS = 'test-api-key-123';

let app: import('express').Express;

// Mock soroban service to avoid actual RPC calls
vi.mock('../services/soroban', () => ({
  sorobanService: {
    contractSimulate: vi.fn().mockResolvedValue({
      transactionHash: 'abc123',
      transactionEnvelopeXdr: 'AAAAAgAAAABDrzABL2F/tOvT8T8V++T8KqP1V8DWaFmDVvQJTJTN6w==',
    }),
    submitFundingTransaction: vi.fn(),
  },
}));

// Mock asyncPipeline to avoid actual queue operations
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

describe('POST /api/v1/fund/prepare - Fee Information', () => {
  const validFundPrepareRequest = {
    sourceAddress: 'GAHFGQNZXHJJRVCCPQO5J3BSFLSPOZG2JMQVNF5XVLNGSYXHFUQ2EXFD',
    targetAddress: 'CAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    tokenAddress: 'CAKMW7CKBZATWFMKM3LZNGXSDX5KQFMYSVQP2GGKWSJQGBGZVYBZKX4',
    amount: '1000000',
    memo: 'test',
  };

  it('response includes feeBps and feeAmount fields', async () => {
    const res = await request(app)
      .post('/api/v1/fund/prepare')
      .set('X-API-Key', 'test-api-key-123')
      .send(validFundPrepareRequest);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('feeBps');
    expect(res.body).toHaveProperty('feeAmount');
  });

  it('feeBps matches configuration', async () => {
    const res = await request(app)
      .post('/api/v1/fund/prepare')
      .set('X-API-Key', 'test-api-key-123')
      .send(validFundPrepareRequest);

    expect(res.status).toBe(200);
    expect(res.body.feeBps).toBe(30);
  });

  it('feeAmount is calculated correctly (amount * feeBps / 10000)', async () => {
    const amount = '1000000';
    const feeBps = 30;
    const expectedFee = (BigInt(amount) * BigInt(feeBps)) / 10000n;

    const res = await request(app)
      .post('/api/v1/fund/prepare')
      .set('X-API-Key', 'test-api-key-123')
      .send(validFundPrepareRequest);

    expect(res.status).toBe(200);
    expect(BigInt(res.body.feeAmount)).toBe(expectedFee);
  });

  it('response includes netAmount (amount - feeAmount)', async () => {
    const res = await request(app)
      .post('/api/v1/fund/prepare')
      .set('X-API-Key', 'test-api-key-123')
      .send(validFundPrepareRequest);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('netAmount');

    const amount = BigInt(validFundPrepareRequest.amount);
    const feeAmount = BigInt(res.body.feeAmount);
    const expectedNetAmount = amount - feeAmount;

    expect(BigInt(res.body.netAmount)).toBe(expectedNetAmount);
  });

  it('fee calculation handles large amounts', async () => {
    const largeAmountRequest = {
      ...validFundPrepareRequest,
      amount: '100000000000000',
    };

    const res = await request(app)
      .post('/api/v1/fund/prepare')
      .set('X-API-Key', 'test-api-key-123')
      .send(largeAmountRequest);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('feeBps');
    expect(res.body).toHaveProperty('feeAmount');
    expect(res.body).toHaveProperty('netAmount');
  });
});
