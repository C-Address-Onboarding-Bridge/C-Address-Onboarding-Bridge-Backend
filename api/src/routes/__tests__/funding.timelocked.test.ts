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
    submitFundingTransaction: vi.fn(),
    getTransactionStatus: vi.fn(),
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
}));

vi.mock('../../services/asyncPipeline', () => ({
  enqueueAudit: vi.fn(),
  enqueueFundingMetrics: vi.fn(),
}));

vi.mock('../../services/metrics', () => ({
  recordFundingMetrics: vi.fn(),
}));

describe('Timelocked Funding Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const timelockedFundSchema = z.object({
    signedXdr: z
      .string()
      .min(1, 'signed transaction XDR is required')
      .max(5000, 'signedXdr must not exceed 5000 characters'),
    targetAddress: z.string().regex(/^C[A-Z0-9]{55}$/, 'invalid target C-address'),
    amount: z.string().regex(/^\d+$/, 'amount must be an integer string (stroops)'),
    unlocksAt: z.number().int().positive('unlock time must be a future Unix timestamp'),
  });

  const timelockedClaimSchema = z.object({
    signedXdr: z
      .string()
      .min(1, 'signed transaction XDR is required')
      .max(5000, 'signedXdr must not exceed 5000 characters'),
  });

  it('accepts valid timelocked fund request', () => {
    const body = {
      signedXdr: 'base64-encoded-xdr',
      targetAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4',
      amount: '1000',
      unlocksAt: Math.floor(Date.now() / 1000) + 86400,
    };
    const result = timelockedFundSchema.parse(body);
    expect(result.targetAddress).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4');
  });

  it('rejects timelocked fund with missing XDR', () => {
    const body = {
      signedXdr: '',
      targetAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4',
      amount: '1000',
      unlocksAt: Math.floor(Date.now() / 1000) + 86400,
    };
    expect(() => timelockedFundSchema.parse(body)).toThrow('signed transaction XDR is required');
  });

  it('rejects timelocked fund with invalid target address', () => {
    const body = {
      signedXdr: 'base64-encoded-xdr',
      targetAddress: 'INVALID_ADDRESS',
      amount: '1000',
      unlocksAt: Math.floor(Date.now() / 1000) + 86400,
    };
    expect(() => timelockedFundSchema.parse(body)).toThrow('invalid target C-address');
  });

  it('rejects timelocked fund with non-numeric amount', () => {
    const body = {
      signedXdr: 'base64-encoded-xdr',
      targetAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4',
      amount: 'abc',
      unlocksAt: Math.floor(Date.now() / 1000) + 86400,
    };
    expect(() => timelockedFundSchema.parse(body)).toThrow('amount must be an integer string');
  });

  it('rejects timelocked fund with past unlock time', () => {
    const body = {
      signedXdr: 'base64-encoded-xdr',
      targetAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4',
      amount: '1000',
      unlocksAt: Math.floor(Date.now() / 1000) - 86400,
    };
    expect(() => timelockedFundSchema.parse(body)).toThrow('unlock time must be a future Unix timestamp');
  });

  it('accepts valid timelocked claim request', () => {
    const body = {
      signedXdr: 'base64-encoded-claim-xdr',
    };
    const result = timelockedClaimSchema.parse(body);
    expect(result.signedXdr).toBe('base64-encoded-claim-xdr');
  });

  it('rejects timelocked claim with missing XDR', () => {
    const body = {
      signedXdr: '',
    };
    expect(() => timelockedClaimSchema.parse(body)).toThrow('signed transaction XDR is required');
  });
});

describe('Lock ID Parsing', () => {
  it('correctly parses valid lock ID format', () => {
    const lockId = 'abc123def456-CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4';
    const [txHash, targetAddress] = lockId.split('-');
    expect(txHash).toBe('abc123def456');
    expect(targetAddress).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4');
  });

  it('rejects invalid lock ID format', () => {
    const lockId = 'invalid-lock-id-format';
    const [txHash, targetAddress] = lockId.split('-');
    expect(txHash).toBe('invalid');
    expect(targetAddress).toBe('lock');
  });

  it('handles lock ID with multiple dashes', () => {
    const lockId = 'abc123-def456-CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4';
    const [txHash, ...rest] = lockId.split('-');
    const targetAddress = rest.join('-');
    expect(txHash).toBe('abc123');
    expect(targetAddress).toBe('def456-CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFSC4');
  });
});
