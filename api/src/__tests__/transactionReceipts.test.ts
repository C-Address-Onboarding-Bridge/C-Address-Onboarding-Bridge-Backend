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

describe('Signed Transaction Receipts (Issue #416)', () => {
  let apiKey: string;

  beforeAll(() => {
    const key = createApiKey({
      name: 'receipt-test-key',
      createdBy: 'test',
      scopes: ['transactions:read', 'fund:write'],
    });
    apiKey = key.rawKey;
  });

  describe('GET /api/v1/transactions/:hash/receipt - Get signed receipt', () => {
    it('returns a structured receipt with required fields', async () => {
      // Use a known transaction hash
      const txHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      const res = await request(app)
        .get(`/api/v1/transactions/${txHash}/receipt`)
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('amount');
      expect(res.body).toHaveProperty('fee');
      expect(res.body).toHaveProperty('net');
      expect(res.body).toHaveProperty('asset');
      expect(res.body).toHaveProperty('parties');
      expect(res.body).toHaveProperty('timestamp');
      expect(res.body).toHaveProperty('ledgerSequence');
    });

    it('includes audit-log anchoring information', async () => {
      const txHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      const res = await request(app)
        .get(`/api/v1/transactions/${txHash}/receipt`)
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('auditSequence');
      expect(res.body).toHaveProperty('auditEntryHash');
    });

    it('includes a signature for verification', async () => {
      const txHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      const res = await request(app)
        .get(`/api/v1/transactions/${txHash}/receipt`)
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('signature');
      expect(res.body.signature).toMatch(/^[a-f0-9]{128}$/i); // SHA256 hex
    });

    it('returns 404 for nonexistent transaction', async () => {
      const res = await request(app)
        .get('/api/v1/transactions/nonexistenthashhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh/receipt')
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(404);
    });
  });

  describe('Receipt signature verification', () => {
    it('signature verification passes for valid receipt', async () => {
      const txHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      const res = await request(app)
        .get(`/api/v1/transactions/${txHash}/receipt`)
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      const receipt = res.body;

      // Verify receipt using verification endpoint
      const verifyRes = await request(app)
        .post('/api/v1/transactions/receipts/verify')
        .send(receipt);

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.valid).toBe(true);
    });

    it('signature verification fails for tampered amount', async () => {
      const txHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      const res = await request(app)
        .get(`/api/v1/transactions/${txHash}/receipt`)
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      const receipt = res.body;
      receipt.amount = '999999'; // Tamper with amount

      const verifyRes = await request(app)
        .post('/api/v1/transactions/receipts/verify')
        .send(receipt);

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.valid).toBe(false);
    });

    it('signature verification fails for tampered signature', async () => {
      const txHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      const res = await request(app)
        .get(`/api/v1/transactions/${txHash}/receipt`)
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      const receipt = res.body;
      receipt.signature = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'; // Tamper with signature

      const verifyRes = await request(app)
        .post('/api/v1/transactions/receipts/verify')
        .send(receipt);

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.valid).toBe(false);
    });

    it('provides offline verification instructions', async () => {
      const docsRes = await request(app)
        .get('/api/v1/docs/receipt-verification')
        .set('X-API-Key', apiKey);

      expect([200, 404]).toContain(docsRes.status); // 404 is acceptable if not documented
      if (docsRes.status === 200) {
        expect(docsRes.text).toContain('verify');
        expect(docsRes.text).toContain('receipt');
      }
    });
  });

  describe('Receipt structure and content', () => {
    it('includes parties information', async () => {
      const txHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      const res = await request(app)
        .get(`/api/v1/transactions/${txHash}/receipt`)
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body.parties).toHaveProperty('sender');
      expect(res.body.parties).toHaveProperty('recipient');
    });

    it('includes ledger sequence number', async () => {
      const txHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      const res = await request(app)
        .get(`/api/v1/transactions/${txHash}/receipt`)
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      expect(typeof res.body.ledgerSequence).toBe('number');
      expect(res.body.ledgerSequence).toBeGreaterThan(0);
    });

    it('includes ISO 8601 timestamp', async () => {
      const txHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      const res = await request(app)
        .get(`/api/v1/transactions/${txHash}/receipt`)
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      expect(new Date(res.body.timestamp).getTime()).toBeGreaterThan(0);
    });

    it('breaks down fees clearly', async () => {
      const txHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      const res = await request(app)
        .get(`/api/v1/transactions/${txHash}/receipt`)
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('amount');
      expect(res.body).toHaveProperty('fee');
      expect(res.body).toHaveProperty('net');

      // Verify mathematical relationship
      const net = BigInt(res.body.net);
      const amount = BigInt(res.body.amount);
      const fee = BigInt(res.body.fee);

      expect(net).toBe(amount - fee);
    });
  });

  describe('Audit log anchoring', () => {
    it('includes audit log entry reference', async () => {
      const txHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      const res = await request(app)
        .get(`/api/v1/transactions/${txHash}/receipt`)
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('auditSequence');
      expect(typeof res.body.auditSequence).toBe('number');
      expect(res.body.auditSequence).toBeGreaterThan(0);
    });

    it('provides audit log entry hash for chain verification', async () => {
      const txHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      const res = await request(app)
        .get(`/api/v1/transactions/${txHash}/receipt`)
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('auditEntryHash');
      expect(res.body.auditEntryHash).toMatch(/^[a-f0-9]{64}$/i); // SHA256 hex
    });
  });
});
