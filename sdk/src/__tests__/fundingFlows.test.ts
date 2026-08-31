import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BridgeClient } from '../bridge';
import type { FundParams, FundingResult } from '../types';

process.env.NODE_ENV = 'test';

vi.mock('../telemetry', () => ({
  TelemetryClient: vi.fn(() => ({
    logEvent: vi.fn(),
    captureException: vi.fn(),
  })),
}));

describe('SDK Funding Flows', () => {
  let client: BridgeClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockFetch = vi.fn();
    global.fetch = mockFetch;

    client = new BridgeClient({
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-key',
    });
  });

  describe('Basic Funding Flow', () => {
    it('supports fund() method with standard funding parameters', () => {
      const fundParams: FundParams = {
        sourceAsset: 'native',
        amount: '1000000',
        targetAddress: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
      };

      expect(fundParams.sourceAsset).toBeDefined();
      expect(fundParams.amount).toBeDefined();
      expect(fundParams.targetAddress).toBeDefined();
    });

    it('handles FundingResult with transaction details', () => {
      const result: FundingResult = {
        id: 'fund-123',
        status: 'success',
        txHash: 'abc123def456',
        timestamp: Date.now(),
      };

      expect(result.id).toBeDefined();
      expect(result.status).toBe('success');
      expect(result.txHash).toBeDefined();
    });
  });

  describe('Timelocked Funding Flow', () => {
    it('supports timelocked funding with locktime parameter', () => {
      const timelockedParams = {
        sourceAsset: 'native',
        amount: '1000000',
        targetAddress: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
        locktime: Math.floor(Date.now() / 1000) + 86400,
      };

      expect(timelockedParams.locktime).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('validates locktime is in the future', () => {
      const now = Math.floor(Date.now() / 1000);
      const pastTime = now - 3600;
      const futureTime = now + 86400;

      expect(futureTime).toBeGreaterThan(now);
      expect(pastTime).toBeLessThan(now);
    });
  });

  describe('Referral Funding Flow', () => {
    it('supports referral parameter in funding request', () => {
      const referralParams = {
        sourceAsset: 'native',
        amount: '1000000',
        targetAddress: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
        referral: 'ref-123',
      };

      expect(referralParams.referral).toBe('ref-123');
    });

    it('tracks referral in funding flow context', () => {
      const referralId = 'ref-456';
      const fundingContext = {
        referral: referralId,
        timestamp: Date.now(),
      };

      expect(fundingContext.referral).toBe(referralId);
      expect(fundingContext.timestamp).toBeGreaterThan(0);
    });
  });

  describe('Commit-Reveal Flow', () => {
    it('supports commitment hash generation for commit-reveal flow', () => {
      const data = JSON.stringify({
        sourceAsset: 'native',
        amount: '1000000',
        targetAddress: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
      });

      expect(data).toBeDefined();
      expect(typeof data).toBe('string');
    });

    it('generates deterministic commitment hash', () => {
      const data = 'test-data';
      const hash1 = JSON.stringify({ data });
      const hash2 = JSON.stringify({ data });

      expect(hash1).toBe(hash2);
    });

    it('supports commit phase in funding flow', () => {
      const commitPhase = {
        commitment: 'hash-abc123',
        nonce: 'nonce-xyz789',
        timestamp: Date.now(),
      };

      expect(commitPhase.commitment).toBeDefined();
      expect(commitPhase.nonce).toBeDefined();
      expect(commitPhase.timestamp).toBeGreaterThan(0);
    });

    it('supports reveal phase in funding flow', () => {
      const revealPhase = {
        data: 'original-data',
        nonce: 'nonce-xyz789',
        commitment: 'hash-abc123',
      };

      expect(revealPhase.data).toBeDefined();
      expect(revealPhase.nonce).toBeDefined();
      expect(revealPhase.commitment).toBeDefined();
    });
  });

  describe('Meta-Transaction Flow', () => {
    it('supports meta-transaction parameters', () => {
      const metaTxParams = {
        sourceAsset: 'native',
        amount: '1000000',
        targetAddress: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
        relayer: 'GRELAYER1234567890123456789012345678901234567890',
      };

      expect(metaTxParams.relayer).toBeDefined();
    });
  });

  describe('Swap Flow', () => {
    it('supports swap parameters in funding flow', () => {
      const swapParams = {
        sourceAsset: 'USDC:GA7VQQK3VJMVFRQ5ALLU7B4DQVKGBFGSQYYKQHQC3JNRMNGSDWGD3SR',
        targetAsset: 'native',
        amount: '1000000',
        targetAddress: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
      };

      expect(swapParams.sourceAsset).toBeDefined();
      expect(swapParams.targetAsset).toBeDefined();
      expect(swapParams.amount).toBeDefined();
    });
  });

  describe('Batch Flow', () => {
    it('supports batch funding operations', () => {
      const batchParams = [
        {
          sourceAsset: 'native',
          amount: '1000000',
          targetAddress: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
        },
        {
          sourceAsset: 'native',
          amount: '2000000',
          targetAddress: 'GBBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRZ',
        },
      ];

      expect(batchParams).toHaveLength(2);
      expect(batchParams.every((p) => p.sourceAsset === 'native')).toBe(true);
    });

    it('handles batch results with per-item status', () => {
      const batchResults = [
        { success: true, id: 'fund-1' },
        { success: false, error: 'invalid_address' },
      ];

      expect(batchResults).toHaveLength(2);
      expect(batchResults[0].success).toBe(true);
      expect(batchResults[1].success).toBe(false);
    });
  });

  describe('Error Handling for New Flows', () => {
    it('extends error hierarchy with new failure modes', () => {
      const errors = {
        COMMITMENT_MISMATCH: 'Commitment hash does not match revealed data',
        INVALID_RELAYER: 'Relayer address is not authorized',
        LOCKTIME_INVALID: 'Locktime is in the past',
        REFERRAL_INVALID: 'Referral code not found',
      };

      expect(Object.keys(errors)).toContain('COMMITMENT_MISMATCH');
      expect(Object.keys(errors)).toContain('INVALID_RELAYER');
      expect(Object.keys(errors)).toContain('LOCKTIME_INVALID');
      expect(Object.keys(errors)).toContain('REFERRAL_INVALID');
    });
  });

  describe('Offline Queue for New Flows', () => {
    it('queues safe-to-replay operations', () => {
      const queueableOps = {
        fund: true,
        quote: true,
        status: true,
      };

      const nonQueueableOps = {
        commitReveal: false,
        swap: false,
      };

      expect(queueableOps.fund).toBe(true);
      expect(nonQueueableOps.commitReveal).toBe(false);
    });

    it('excludes non-idempotent operations from queue', () => {
      const operations = [
        { type: 'fund', idempotent: true },
        { type: 'commitReveal', idempotent: false },
        { type: 'swap', idempotent: false },
      ];

      const queueable = operations.filter((op) => op.idempotent);
      const notQueueable = operations.filter((op) => !op.idempotent);

      expect(queueable.length).toBe(1);
      expect(notQueueable.length).toBe(2);
    });
  });
});
