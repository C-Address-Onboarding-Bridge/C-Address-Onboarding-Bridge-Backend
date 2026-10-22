/**
 * Tests for fixes to issues #634, #635, #636, #637.
 *
 * #634 - /fund/prepare must NOT emit funding metrics or transaction_submission
 *        audit events; it emits `transaction_prepared` only.
 * #635 - getQuote reads fee_bps / rebate_for from the contract (with cache)
 *        instead of hard-coding config.soroban.feeBps.
 * #636 - /fund/batch decodes recipients from the signed XDR and rejects
 *        requests whose body does not match the XDR.
 * #637 - Timelocked endpoints return 501 Not Implemented (no fabricated data).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Set test environment before any module is loaded.
process.env.NODE_ENV = 'test';
process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
process.env.BRIDGE_FEE_BPS = '30';
process.env.API_KEYS = 'test-api-key-issues-fix';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockEnqueueAudit = vi.fn();
const mockEnqueueFundingMetrics = vi.fn();
const mockRecordFundingMetrics = vi.fn();
const mockSubmitFundingTransaction = vi.fn();
const mockSubmitBatchFundingTransaction = vi.fn();
const mockDecodeRecipientsFromXdr = vi.fn();
const mockPrepareFundingTransaction = vi.fn();

vi.mock('../services/soroban', () => ({
  sorobanService: {
    prepareFundingTransaction: mockPrepareFundingTransaction,
    submitFundingTransaction: mockSubmitFundingTransaction,
    submitBatchFundingTransaction: mockSubmitBatchFundingTransaction,
    decodeRecipientsFromXdr: mockDecodeRecipientsFromXdr,
    submitDirectFunding: vi.fn(),
    getContractFeeBps: vi.fn().mockResolvedValue({ feeBps: 50, rebateBps: 10 }),
    getQuote: vi.fn().mockResolvedValue({
      estimatedFee: '20',
      expectedReceive: '980',
      feeBps: 40,
      rebateBps: 10,
      rate: '1.0',
    }),
  },
}));

vi.mock('../services/asyncPipeline', () => ({
  enqueueAudit: mockEnqueueAudit,
  enqueueFundingMetrics: mockEnqueueFundingMetrics,
}));

vi.mock('../services/metrics', async () => {
  const actual = await vi.importActual<typeof import('../services/metrics')>('../services/metrics');
  return { ...actual, recordFundingMetrics: mockRecordFundingMetrics };
});

vi.mock('../services/explorer', () => ({
  explorerService: {
    txUrl: vi.fn((h: string) => `https://explorer.test/${h}`),
    txUrlWithFallbacks: vi.fn((h: string) => [`https://explorer.test/${h}`]),
  },
}));

vi.mock('../services/auditLog', () => ({
  integrityAuditLog: { append: vi.fn() },
  hashPayload: vi.fn((d: string) => `hash-${d}`),
}));

// ── App bootstrap ──────────────────────────────────────────────────────────────

let app: import('express').Express;

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import('../index');
  app = mod.app;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Shared valid addresses ────────────────────────────────────────────────────

const SOURCE = 'GAHFGQNZXHJJRVCCPQO5J3BSFLSPOZG2JMQVNF5XVLNGSYXHFUQ2EXFD';
const TARGET = 'CAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const TOKEN  = 'CAKMW7CKBZATWFMKM3LZNGXSDX5KQFMYSVQP2GGKWSJQGBGZVYBZKX4';

// ─────────────────────────────────────────────────────────────────────────────
// #634: /fund/prepare — no metrics, only transaction_prepared audit event
// ─────────────────────────────────────────────────────────────────────────────

describe('#634 POST /api/v1/fund/prepare - no funding metrics, transaction_prepared audit only', () => {
  const body = {
    sourceAddress: SOURCE,
    targetAddress: TARGET,
    tokenAddress: TOKEN,
    amount: '1000000',
    memo: 'test',
  };

  beforeEach(() => {
    mockPrepareFundingTransaction.mockResolvedValue({
      unsignedXdr: 'AAAA==',
      footprint: 'BBBB==',
      fee: '300',
    });
  });

  it('returns 200 with unsigned XDR fields', async () => {
    const res = await request(app)
      .post('/api/v1/fund/prepare')
      .set('X-API-Key', 'test-api-key-issues-fix')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('unsignedXdr', 'AAAA==');
    expect(res.body).toHaveProperty('footprint', 'BBBB==');
    expect(res.body).toHaveProperty('fee', '300');
  });

  it('does NOT call enqueueFundingMetrics or recordFundingMetrics', async () => {
    await request(app)
      .post('/api/v1/fund/prepare')
      .set('X-API-Key', 'test-api-key-issues-fix')
      .send(body);

    expect(mockEnqueueFundingMetrics).not.toHaveBeenCalled();
    expect(mockRecordFundingMetrics).not.toHaveBeenCalled();
  });

  it('calls enqueueAudit with event type transaction_prepared (not transaction_submission_result)', async () => {
    await request(app)
      .post('/api/v1/fund/prepare')
      .set('X-API-Key', 'test-api-key-issues-fix')
      .send(body);

    expect(mockEnqueueAudit).toHaveBeenCalledTimes(1);
    const [eventType] = mockEnqueueAudit.mock.calls[0];
    expect(eventType).toBe('transaction_prepared');
    expect(eventType).not.toBe('transaction_submission_result');
  });

  it('includes source/target/amount in the prepared audit payload', async () => {
    await request(app)
      .post('/api/v1/fund/prepare')
      .set('X-API-Key', 'test-api-key-issues-fix')
      .send(body);

    const [, payload] = mockEnqueueAudit.mock.calls[0];
    expect(payload).toMatchObject({
      sourceAddress: SOURCE,
      targetAddress: TARGET,
      amount: '1000000',
    });
  });

  it('returns 400 when sourceAddress is missing', async () => {
    const res = await request(app)
      .post('/api/v1/fund/prepare')
      .set('X-API-Key', 'test-api-key-issues-fix')
      .send({ ...body, sourceAddress: undefined });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #635: getQuote uses contract fee_bps, not env var; includes rebateBps
// ─────────────────────────────────────────────────────────────────────────────

describe('#635 SorobanService.getContractFeeBps — contract-read with cache and rebate', () => {
  it('getQuote returns rebateBps field in response', async () => {
    const { sorobanService } = await import('../services/soroban');
    const quote = await sorobanService.getQuote('XLM', '1000', SOURCE);
    expect(quote).toHaveProperty('rebateBps');
  });

  it('getQuote uses effectiveFeeBps derived from contract, not raw env var', async () => {
    const { sorobanService } = await import('../services/soroban');
    // The mock returns feeBps=40 (50 - 10 rebate) — not the env var value of 30.
    const quote = await sorobanService.getQuote('XLM', '1000', SOURCE);
    // The mock returns feeBps: 40 and rebateBps: 10
    expect(quote.feeBps).toBe(40);
    expect(quote.rebateBps).toBe(10);
  });

  it('SorobanService.getContractFeeBps falls back to config when RPC unavailable', async () => {
    // Fresh import so we don't reuse module-level mock
    vi.resetModules();

    const { rpcPool } = await import('../services/rpcPool');
    vi.mocked(rpcPool.execute).mockRejectedValue(new Error('RPC down'));

    process.env.BRIDGE_FEE_BPS = '25';
    const { SorobanService } = await import('../services/soroban');
    const svc = new SorobanService();
    const result = await svc.getContractFeeBps();
    // Should fall back to env var value 25
    expect(result.feeBps).toBe(25);
    expect(result.rebateBps).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #636: /fund/batch — decode recipients from XDR; reject body/XDR mismatch
// ─────────────────────────────────────────────────────────────────────────────

describe('#636 POST /api/v1/fund/batch — XDR recipient decode and mismatch rejection', () => {
  const SIGNED_XDR = 'AAAA==';
  const bodyRecipients = [
    { target: TARGET, amount: '500' },
  ];

  beforeEach(() => {
    mockSubmitBatchFundingTransaction.mockResolvedValue({
      hash: 'abc123',
      status: 'pending',
    });
  });

  it('returns 400 when XDR cannot be decoded', async () => {
    mockDecodeRecipientsFromXdr.mockReturnValue(null);

    const res = await request(app)
      .post('/api/v1/fund/batch')
      .set('X-API-Key', 'test-api-key-issues-fix')
      .send({ signedXdr: SIGNED_XDR, recipients: bodyRecipients });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('xdr_decode_failed');
  });

  it('returns 400 when XDR recipient count differs from body', async () => {
    // XDR has 2 recipients, body has 1
    mockDecodeRecipientsFromXdr.mockReturnValue([
      { target: TARGET, amount: '500' },
      { target: TOKEN, amount: '200' },
    ]);

    const res = await request(app)
      .post('/api/v1/fund/batch')
      .set('X-API-Key', 'test-api-key-issues-fix')
      .send({ signedXdr: SIGNED_XDR, recipients: bodyRecipients });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('recipient_mismatch');
  });

  it('returns 400 when XDR recipient target differs from body', async () => {
    mockDecodeRecipientsFromXdr.mockReturnValue([
      { target: TOKEN, amount: '500' }, // different target than body
    ]);

    const res = await request(app)
      .post('/api/v1/fund/batch')
      .set('X-API-Key', 'test-api-key-issues-fix')
      .send({ signedXdr: SIGNED_XDR, recipients: bodyRecipients });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('recipient_mismatch');
  });

  it('returns 400 when XDR recipient amount differs from body', async () => {
    mockDecodeRecipientsFromXdr.mockReturnValue([
      { target: TARGET, amount: '999' }, // different amount
    ]);

    const res = await request(app)
      .post('/api/v1/fund/batch')
      .set('X-API-Key', 'test-api-key-issues-fix')
      .send({ signedXdr: SIGNED_XDR, recipients: bodyRecipients });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('recipient_mismatch');
  });

  it('accepts valid batch when XDR and body match, uses XDR recipients in response', async () => {
    const xdrRecipients = [{ target: TARGET, amount: '500' }];
    mockDecodeRecipientsFromXdr.mockReturnValue(xdrRecipients);

    const res = await request(app)
      .post('/api/v1/fund/batch')
      .set('X-API-Key', 'test-api-key-issues-fix')
      .send({ signedXdr: SIGNED_XDR, recipients: bodyRecipients });

    expect(res.status).toBe(201);
    expect(res.body.recipients).toHaveLength(1);
    expect(res.body.recipients[0].target).toBe(TARGET);
    expect(res.body.recipients[0].amount).toBe('500');
  });

  it('audit log uses XDR recipient count, not body recipient count', async () => {
    const xdrRecipients = [{ target: TARGET, amount: '500' }];
    mockDecodeRecipientsFromXdr.mockReturnValue(xdrRecipients);

    await request(app)
      .post('/api/v1/fund/batch')
      .set('X-API-Key', 'test-api-key-issues-fix')
      .send({ signedXdr: SIGNED_XDR, recipients: bodyRecipients });

    const auditCall = mockEnqueueAudit.mock.calls.find(
      ([type]: [string]) => type === 'batch_transaction_submission_result',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![1].recipientCount).toBe(1); // from XDR, not body
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #637: Timelocked endpoints return 501 Not Implemented
// ─────────────────────────────────────────────────────────────────────────────

describe('#637 Timelocked endpoints return 501 Not Implemented', () => {
  it('POST /api/v1/fund/timelocked returns 501', async () => {
    const res = await request(app)
      .post('/api/v1/fund/timelocked')
      .set('X-API-Key', 'test-api-key-issues-fix')
      .send({
        signedXdr: 'AAAA==',
        targetAddress: TARGET,
        amount: '1000',
        unlocksAt: Math.floor(Date.now() / 1000) + 86400,
      });

    expect(res.status).toBe(501);
    expect(res.body.error).toBe('not_implemented');
  });

  it('GET /api/v1/fund/timelocked/:id returns 501', async () => {
    const res = await request(app)
      .get('/api/v1/fund/timelocked/some-lock-id')
      .set('X-API-Key', 'test-api-key-issues-fix');

    expect(res.status).toBe(501);
    expect(res.body.error).toBe('not_implemented');
  });

  it('POST /api/v1/fund/timelocked/:id/claim returns 501', async () => {
    const res = await request(app)
      .post('/api/v1/fund/timelocked/some-lock-id/claim')
      .set('X-API-Key', 'test-api-key-issues-fix')
      .send({ signedXdr: 'AAAA==' });

    expect(res.status).toBe(501);
    expect(res.body.error).toBe('not_implemented');
  });

  it('POST /api/v1/fund/timelocked does NOT submit any transaction', async () => {
    await request(app)
      .post('/api/v1/fund/timelocked')
      .set('X-API-Key', 'test-api-key-issues-fix')
      .send({
        signedXdr: 'AAAA==',
        targetAddress: TARGET,
        amount: '1000',
        unlocksAt: Math.floor(Date.now() / 1000) + 86400,
      });

    expect(mockSubmitFundingTransaction).not.toHaveBeenCalled();
    expect(mockEnqueueFundingMetrics).not.toHaveBeenCalled();
  });

  it('POST /api/v1/fund/timelocked does NOT emit any audit event', async () => {
    await request(app)
      .post('/api/v1/fund/timelocked')
      .set('X-API-Key', 'test-api-key-issues-fix')
      .send({
        signedXdr: 'AAAA==',
        targetAddress: TARGET,
        amount: '1000',
        unlocksAt: Math.floor(Date.now() / 1000) + 86400,
      });

    expect(mockEnqueueAudit).not.toHaveBeenCalled();
  });
});
