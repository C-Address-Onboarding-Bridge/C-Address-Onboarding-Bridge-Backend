import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

process.env.NODE_ENV = 'test';

vi.mock('../../config', () => ({
  config: {
    soroban: { rpcUrls: [], feeBps: 100, bridgeContractId: 'test-contract', networkPassphrase: 'Test' },
    logging: { version: '0.1.0', serviceName: 'test', environment: 'test', sensitiveFields: [], bodyTruncateLength: 200 },
  },
}));

vi.mock('../../services/soroban', () => ({
  sorobanService: {
    submitBatchFundingTransaction: vi.fn(),
  },
}));

vi.mock('../../services/explorer', () => ({
  explorerService: {
    txUrl: vi.fn((hash) => `https://explorer.test/${hash}`),
    txUrlWithFallbacks: vi.fn((hash) => [`https://explorer.test/${hash}`]),
  },
}));

vi.mock('../../services/auditLog', () => ({
  integrityAuditLog: {
    append: vi.fn(),
  },
  hashPayload: vi.fn((data) => `hash-${data}`),
  enqueueAudit: vi.fn(),
}));

vi.mock('../../services/asyncPipeline', () => ({
  enqueueAudit: vi.fn(),
  enqueueFundingMetrics: vi.fn(),
}));

vi.mock('../../services/metrics', () => ({
  recordFundingMetrics: vi.fn(),
}));

import { sorobanService } from '../../services/soroban';

describe('Batch Funding Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const batchFundSchema = z.object({
    signedXdr: z
      .string()
      .min(1, 'signed transaction XDR is required')
      .max(5000, 'signedXdr must not exceed 5000 characters'),
    recipients: z.array(
      z.object({
        target: z.string().regex(/^C[A-Z0-9]{55}$/, 'invalid target C-address'),
        amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
      }),
    ).min(1, 'at least one recipient is required').max(100, 'maximum 100 recipients per batch'),
  });

  it('accepts valid batch fund request with single recipient', () => {
    const body = {
      signedXdr: 'base64-encoded-xdr',
      recipients: [
        { target: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4', amount: '1000' },
      ],
    };
    const result = batchFundSchema.parse(body);
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0].amount).toBe('1000');
  });

  it('accepts valid batch fund request with multiple recipients', () => {
    const body = {
      signedXdr: 'base64-encoded-xdr',
      recipients: [
        { target: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4', amount: '1000' },
        { target: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBFVJ7', amount: '2000' },
      ],
    };
    const result = batchFundSchema.parse(body);
    expect(result.recipients).toHaveLength(2);
  });

  it('rejects batch fund request with no recipients', () => {
    const body = {
      signedXdr: 'base64-encoded-xdr',
      recipients: [],
    };
    expect(() => batchFundSchema.parse(body)).toThrow('at least one recipient is required');
  });

  it('rejects batch fund request exceeding max recipients', () => {
    const recipients = Array.from({ length: 101 }, (_, i) => ({
      target: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4',
      amount: '1000',
    }));
    const body = {
      signedXdr: 'base64-encoded-xdr',
      recipients,
    };
    expect(() => batchFundSchema.parse(body)).toThrow('maximum 100 recipients per batch');
  });

  it('rejects batch fund request with invalid XDR', () => {
    const body = {
      signedXdr: '',
      recipients: [{ target: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4', amount: '1000' }],
    };
    expect(() => batchFundSchema.parse(body)).toThrow('signed transaction XDR is required');
  });

  it('rejects batch fund request with invalid target address', () => {
    const body = {
      signedXdr: 'base64-encoded-xdr',
      recipients: [{ target: 'INVALID_ADDRESS', amount: '1000' }],
    };
    expect(() => batchFundSchema.parse(body)).toThrow('invalid target C-address');
  });

  it('rejects batch fund request with non-numeric amount', () => {
    const body = {
      signedXdr: 'base64-encoded-xdr',
      recipients: [{ target: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4', amount: 'abc' }],
    };
    expect(() => batchFundSchema.parse(body)).toThrow('amount must be an integer string');
  });
});
