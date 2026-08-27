import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
process.env.BRIDGE_FEE_BPS = '30';
process.env.API_KEYS = 'test-api-key-123';

let app: import('express').Express;

// Mock the metrics module to track calls
const mockRecordFundingMetrics = vi.fn();
vi.mock('../services/metrics', async () => {
  const actual = await vi.importActual<typeof import('../services/metrics')>('../services/metrics');
  return {
    ...actual,
    recordFundingMetrics: mockRecordFundingMetrics,
  };
});

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

beforeAll(async () => {
  const mod = await import('../index');
  app = mod.app;
});

afterEach(() => {
  mockRecordFundingMetrics.mockClear();
});

describe('POST /api/v1/fund/prepare - Metrics', () => {
  const validFundPrepareRequest = {
    sourceAddress: 'GAHFGQNZXHJJRVCCPQO5J3BSFLSPOZG2JMQVNF5XVLNGSYXHFUQ2EXFD',
    targetAddress: 'CAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    tokenAddress: 'CAKMW7CKBZATWFMKM3LZNGXSDX5KQFMYSVQP2GGKWSJQGBGZVYBZKX4',
    amount: '1000000',
    memo: 'test',
  };

  it('does NOT call recordFundingMetrics for /prepare endpoint', async () => {
    mockRecordFundingMetrics.mockClear();

    const res = await request(app)
      .post('/api/v1/fund/prepare')
      .set('X-API-Key', 'test-api-key-123')
      .send(validFundPrepareRequest);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('simulation');
    expect(mockRecordFundingMetrics).not.toHaveBeenCalled();
  });

  it('response includes proper simulation structure', async () => {
    const res = await request(app)
      .post('/api/v1/fund/prepare')
      .set('X-API-Key', 'test-api-key-123')
      .send(validFundPrepareRequest);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('instruction');
    expect(res.body).toHaveProperty('simulation');
    expect(res.body).toHaveProperty('params');
  });
});
