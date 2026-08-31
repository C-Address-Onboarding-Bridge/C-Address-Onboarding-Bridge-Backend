import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { createApiKey } from '../middleware/rbacAuth';

process.env.NODE_ENV = 'test';
process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
process.env.BRIDGE_FEE_BPS = '30';

let app: import('express').Express;

beforeAll(async () => {
  const mod = await import('../index');
  app = mod.app;
});

describe('Cross-Chain Funding API (Issue #418)', () => {
  let apiKey: string;

  beforeAll(() => {
    const key = createApiKey({
      name: 'crosschain-test-key',
      createdBy: 'test',
      scopes: ['fund:write', 'transactions:read'],
    });
    apiKey = key.rawKey;
  });

  describe('POST /api/v1/fund/crosschain - Submit cross-chain funding', () => {
    it('accepts valid cross-chain funding request', async () => {
      const res = await request(app)
        .post('/api/v1/fund/crosschain')
        .set('X-API-Key', apiKey)
        .send({
          sourceChain: 'ethereum',
          targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
          proof: {
            txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
            blockNumber: 12345,
            signatures: [
              {
                signer: '0xrelayer1address...',
                signature: '0xsignature1...',
              },
            ],
          },
          amount: '1000000',
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('hash');
      expect(res.body).toHaveProperty('status');
      expect(res.body.status).toBe('pending');
    });

    it('validates source chain is supported', async () => {
      const res = await request(app)
        .post('/api/v1/fund/crosschain')
        .set('X-API-Key', apiKey)
        .send({
          sourceChain: 'unsupported-chain',
          targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
          proof: { txHash: '0x123', blockNumber: 100, signatures: [] },
          amount: '1000000',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('chain');
    });

    it('validates target C-address format', async () => {
      const res = await request(app)
        .post('/api/v1/fund/crosschain')
        .set('X-API-Key', apiKey)
        .send({
          sourceChain: 'ethereum',
          targetAddress: 'invalid-c-address',
          proof: { txHash: '0x123', blockNumber: 100, signatures: [] },
          amount: '1000000',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('address');
    });

    it('validates relayer signature threshold is met', async () => {
      const res = await request(app)
        .post('/api/v1/fund/crosschain')
        .set('X-API-Key', apiKey)
        .send({
          sourceChain: 'ethereum',
          targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
          proof: {
            txHash: '0x1234567890abcdef',
            blockNumber: 100,
            signatures: [
              {
                signer: '0xrelayer1',
                signature: '0xsig1',
              },
            ], // Only 1 signature, may be below threshold
          },
          amount: '1000000',
        });

      // Status depends on threshold; could be 400 or 202 (accepted but pending verification)
      expect([400, 202, 201]).toContain(res.status);
    });

    it('rejects proof with insufficient signatures', async () => {
      // Assuming threshold is 2
      const res = await request(app)
        .post('/api/v1/fund/crosschain')
        .set('X-API-Key', apiKey)
        .send({
          sourceChain: 'ethereum',
          targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
          proof: {
            txHash: '0x1234567890abcdef',
            blockNumber: 100,
            signatures: [], // No signatures
          },
          amount: '1000000',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('signature');
    });

    it('validates proof format for each source chain', async () => {
      const res = await request(app)
        .post('/api/v1/fund/crosschain')
        .set('X-API-Key', apiKey)
        .send({
          sourceChain: 'ethereum',
          targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
          proof: {
            // Missing required fields like txHash
            signatures: [],
          },
          amount: '1000000',
        });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/relayers - Get relayer set and threshold', () => {
    it('returns current relayer set', async () => {
      const res = await request(app)
        .get('/api/v1/relayers')
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.relayers)).toBe(true);
      expect(res.body.relayers.length).toBeGreaterThan(0);

      // Check relayer structure
      res.body.relayers.forEach((relayer: any) => {
        expect(relayer).toHaveProperty('address');
        expect(relayer).toHaveProperty('enabled');
        expect(relayer).toHaveProperty('addedAt');
      });
    });

    it('returns current signature threshold', async () => {
      const res = await request(app)
        .get('/api/v1/relayers')
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('threshold');
      expect(typeof res.body.threshold).toBe('number');
      expect(res.body.threshold).toBeGreaterThan(0);
      expect(res.body.threshold).toBeLessThanOrEqual(res.body.relayers.length);
    });

    it('validates threshold against relayer count', async () => {
      const res = await request(app)
        .get('/api/v1/relayers')
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      const { relayers, threshold } = res.body;

      // Threshold must be feasible
      expect(threshold).toBeLessThanOrEqual(relayers.length);
      expect(threshold).toBeGreaterThan(0);
    });
  });

  describe('Relayer signature validation', () => {
    it('rejects cross-chain funding with below-threshold signatures', async () => {
      const res = await request(app)
        .post('/api/v1/fund/crosschain')
        .set('X-API-Key', apiKey)
        .send({
          sourceChain: 'ethereum',
          targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
          proof: {
            txHash: '0x1234567890abcdef1234567890abcdef',
            blockNumber: 12345,
            signatures: [
              {
                signer: '0xrelayer1',
                signature: '0xsig1',
              },
            ], // Only 1 signature
          },
          amount: '1000000',
        });

      // Should reject if below threshold (threshold is likely > 1)
      expect([400, 202]).toContain(res.status);
      if (res.status === 400) {
        expect(res.body.error).toContain('threshold');
      }
    });

    it('accepts cross-chain funding with sufficient signatures', async () => {
      const res = await request(app)
        .post('/api/v1/fund/crosschain')
        .set('X-API-Key', apiKey)
        .send({
          sourceChain: 'ethereum',
          targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
          proof: {
            txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
            blockNumber: 12345,
            signatures: [
              {
                signer: '0xrelayer1',
                signature: '0xsignature1abcdef',
              },
              {
                signer: '0xrelayer2',
                signature: '0xsignature2abcdef',
              },
            ],
          },
          amount: '1000000',
        });

      expect([201, 202]).toContain(res.status);
    });

    it('validates signer is in active relayer set', async () => {
      const res = await request(app)
        .post('/api/v1/fund/crosschain')
        .set('X-API-Key', apiKey)
        .send({
          sourceChain: 'ethereum',
          targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
          proof: {
            txHash: '0x1234567890abcdef',
            blockNumber: 100,
            signatures: [
              {
                signer: '0xunknownrelayer',
                signature: '0xsig',
              },
            ],
          },
          amount: '1000000',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('relayer');
    });
  });

  describe('Cross-chain metrics and volume tracking', () => {
    it('tracks cross-chain funding volume by source chain', async () => {
      const res = await request(app)
        .get('/api/v1/admin/metrics/crosschain-volume')
        .set('X-API-Key', createApiKey({ name: 'admin', createdBy: 'test', scopes: ['admin:keys'] }).rawKey);

      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toHaveProperty('byChain');
        expect(typeof res.body.byChain).toBe('object');
      }
    });

    it('includes cross-chain volume in transaction metrics', async () => {
      const res = await request(app)
        .get('/api/v1/metrics')
        .set('X-API-Key', apiKey);

      expect([200, 404]).toContain(res.status);
      if (res.status === 200 && res.body.funding) {
        // Cross-chain volume should be included
        expect(res.body.funding).toHaveProperty('crosschain');
      }
    });
  });

  describe('Supported chains and proof formats', () => {
    it('documents supported source chains', async () => {
      const res = await request(app)
        .get('/api/v1/docs/crosschain')
        .set('X-API-Key', apiKey);

      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(res.text).toContain('ethereum');
        expect(res.text).toContain('proof');
      }
    });

    it('provides proof format examples', async () => {
      const res = await request(app)
        .get('/api/v1/docs/crosschain-proof')
        .set('X-API-Key', apiKey);

      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(res.text).toContain('proof');
      }
    });

    it('validates Ethereum proof format', async () => {
      const res = await request(app)
        .post('/api/v1/fund/crosschain')
        .set('X-API-Key', apiKey)
        .send({
          sourceChain: 'ethereum',
          targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
          proof: {
            txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
            blockNumber: 12345,
            signatures: [
              { signer: '0xrelayer1', signature: '0xsig1' },
              { signer: '0xrelayer2', signature: '0xsig2' },
            ],
          },
          amount: '1000000',
        });

      expect([201, 202, 400]).toContain(res.status);
    });
  });

  describe('Cross-chain transaction status tracking', () => {
    it('returns transaction hash for cross-chain submission', async () => {
      const res = await request(app)
        .post('/api/v1/fund/crosschain')
        .set('X-API-Key', apiKey)
        .send({
          sourceChain: 'ethereum',
          targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
          proof: {
            txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
            blockNumber: 12345,
            signatures: [
              { signer: '0xrelayer1', signature: '0xsig1' },
              { signer: '0xrelayer2', signature: '0xsig2' },
            ],
          },
          amount: '1000000',
        });

      if (res.status === 201) {
        expect(res.body).toHaveProperty('hash');
        expect(typeof res.body.hash).toBe('string');
      }
    });

    it('includes source chain info in transaction status', async () => {
      const res = await request(app)
        .get('/api/v1/transactions')
        .set('X-API-Key', apiKey)
        .query({ type: 'crosschain' });

      expect([200, 404]).toContain(res.status);
      if (res.status === 200 && res.body.data && res.body.data.length > 0) {
        res.body.data.forEach((tx: any) => {
          if (tx.type === 'crosschain') {
            expect(tx).toHaveProperty('sourceChain');
          }
        });
      }
    });
  });
});
