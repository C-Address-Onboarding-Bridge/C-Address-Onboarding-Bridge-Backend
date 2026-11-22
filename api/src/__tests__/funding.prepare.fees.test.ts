import { describe, it, expect } from "vitest";
import type { FundingPrepareResult } from "../../../sdk/src/types";

// Recorded response from POST /api/v1/fund/prepare (see api/src/routes/funding.ts).
const recordedPrepareResponse = {
  unsignedXdr: "AAAAAgAAAAB...",
  footprint: "AAAAAQAAAAA...",
  fee: "100",
  sourceAddress: "GSOURCE000000000000000000000000000000000000000000000000000",
  targetAddress: "GTARGET000000000000000000000000000000000000000000000000000",
  tokenAddress: "GTOKEN0000000000000000000000000000000000000000000000000000",
  amount: "10000000",
  memo: "test-memo",
};

describe("POST /api/v1/fund/prepare contract", () => {
  it("matches the SDK FundingPrepareResult type", () => {
    // Compile-time check: the recorded response must be assignable to the SDK type.
    const typed: FundingPrepareResult = recordedPrepareResponse;

// Mock soroban service to avoid actual RPC calls
vi.mock('../services/soroban', () => ({
  sorobanService: {
    contractSimulate: vi.fn().mockResolvedValue({
      transactionHash: 'abc123',
      transactionEnvelopeXdr: 'AAAAAgAAAABDrzABL2F/tOvT8T8V++T8KqP1V8DWaFmDVvQJTJTN6w==',
    }),
    submitFundingTransaction: vi.fn(),
    submitValidatedXdr: vi.fn(),
  },
}));

vi.mock('../services/quote', () => ({
  quoteService: {
    getQuote: vi.fn().mockResolvedValue({ from: 'XLM', to: 'USDC', amount: '10', rate: '1' }),
  },
}));

import express from 'express';
import { fundingRouter } from '../routes/funding';
import { quoteRouter } from '../routes/quote';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/fund', fundingRouter);
  app.use('/quote', quoteRouter);
  return app;
}

describe('route module loading (#797)', () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
  });

  it("exposes unsignedXdr rather than the stale instruction field", () => {
    expect(recordedPrepareResponse).toHaveProperty("unsignedXdr");
    expect(recordedPrepareResponse).not.toHaveProperty("instruction");
  });
});

describe('POST /api/v1/fund - transaction status mapping', () => {
  const validFundRequest = {
    sourceAddress: 'GAHFGQNZXHJJRVCCPQO5J3BSFLSPOZG2JMQVNF5XVLNGSYXHFUQ2EXFD',
    targetAddress: 'CAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    tokenAddress: 'CAKMW7CKBZATWFMKM3LZNGXSDX5KQFMYSVQP2GGKWSJQGBGZVYBZKX4',
    amount: '1000000',
    signedXdr: 'AAAAAgAAAABDrzABL2F/tOvT8T8V++T8KqP1V8DWaFmDVvQJTJTN6w==',
  };

  it('returns 201 when the transaction is pending', async () => {
    const { sorobanService } = await import('../services/soroban');
    vi.mocked(sorobanService.submitValidatedXdr).mockResolvedValueOnce({
      status: 'pending',
      hash: 'deadbeef',
    } as any);

    const res = await request(app)
      .post('/api/v1/fund')
      .set('X-API-Key', 'test-api-key-123')
      .send(validFundRequest);

    expect(res.status).toBe(201);
  });

  it('returns 201 when the transaction succeeded', async () => {
    const { sorobanService } = await import('../services/soroban');
    vi.mocked(sorobanService.submitValidatedXdr).mockResolvedValueOnce({
      status: 'success',
      hash: 'deadbeef',
    } as any);

    const res = await request(app)
      .post('/api/v1/fund')
      .set('X-API-Key', 'test-api-key-123')
      .send(validFundRequest);

    expect(res.status).toBe(201);
  });

  it('returns 422 when the transaction failed', async () => {
    const { sorobanService } = await import('../services/soroban');
    vi.mocked(sorobanService.submitValidatedXdr).mockResolvedValueOnce({
      status: 'failed',
      hash: 'deadbeef',
      error: 'tx rejected by RPC',
    } as any);

    const res = await request(app)
      .post('/api/v1/fund')
      .set('X-API-Key', 'test-api-key-123')
      .send(validFundRequest);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('tx rejected by RPC');
  });

  it('returns 410 when the transaction expired', async () => {
    const { sorobanService } = await import('../services/soroban');
    vi.mocked(sorobanService.submitValidatedXdr).mockResolvedValueOnce({
      status: 'expired',
      hash: 'deadbeef',
    } as any);

    const res = await request(app)
      .post('/api/v1/fund')
      .set('X-API-Key', 'test-api-key-123')
      .send(validFundRequest);

    expect(res.status).toBe(410);
  });
});
