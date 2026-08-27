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

describe('Recipients Address Book (Issue #415)', () => {
  let apiKey: string;
  let apiKey2: string;

  beforeAll(() => {
    const key1 = createApiKey({
      name: 'recipient-test-key',
      createdBy: 'test',
      scopes: ['transactions:read', 'fund:write'],
    });
    apiKey = key1.rawKey;

    const key2 = createApiKey({
      name: 'recipient-test-key-2',
      createdBy: 'test',
      scopes: ['transactions:read', 'fund:write'],
    });
    apiKey2 = key2.rawKey;
  });

  describe('POST /api/v1/recipients - Create recipient', () => {
    it('creates a new recipient with valid C-address', async () => {
      const res = await request(app)
        .post('/api/v1/recipients')
        .set('X-API-Key', apiKey)
        .send({
          label: 'Main Account',
          address: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.label).toBe('Main Account');
      expect(res.body.address).toBe('CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW');
      expect(res.body).toHaveProperty('createdAt');
    });

    it('rejects invalid C-address', async () => {
      const res = await request(app)
        .post('/api/v1/recipients')
        .set('X-API-Key', apiKey)
        .send({
          label: 'Invalid Address',
          address: 'INVALID_ADDRESS',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('enforces label uniqueness per API key', async () => {
      const address1 = 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
      const address2 = 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVX';

      // First creation succeeds
      const res1 = await request(app)
        .post('/api/v1/recipients')
        .set('X-API-Key', apiKey)
        .send({ label: 'Duplicate Label', address: address1 });
      expect(res1.status).toBe(201);

      // Second creation with same label fails
      const res2 = await request(app)
        .post('/api/v1/recipients')
        .set('X-API-Key', apiKey)
        .send({ label: 'Duplicate Label', address: address2 });
      expect(res2.status).toBe(409);
      expect(res2.body.error).toContain('already exists');
    });

    it('allows same label on different API keys', async () => {
      const address1 = 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
      const address2 = 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVX';

      const res1 = await request(app)
        .post('/api/v1/recipients')
        .set('X-API-Key', apiKey)
        .send({ label: 'Shared Label', address: address1 });
      expect(res1.status).toBe(201);

      const res2 = await request(app)
        .post('/api/v1/recipients')
        .set('X-API-Key', apiKey2)
        .send({ label: 'Shared Label', address: address2 });
      expect(res2.status).toBe(201);
    });

    it('enforces maximum recipient count per key', async () => {
      const baseAddress = 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';

      // Create up to max (assuming 100 is max)
      for (let i = 0; i < 100; i++) {
        const res = await request(app)
          .post('/api/v1/recipients')
          .set('X-API-Key', apiKey)
          .send({
            label: `Recipient ${i}`,
            address: baseAddress.slice(0, -1) + i.toString().padStart(1, '0'),
          });

        if (i < 99) {
          expect([201, 409]).toContain(res.status); // 409 if label already exists from other tests
        }
      }

      // Attempt to exceed max
      const res = await request(app)
        .post('/api/v1/recipients')
        .set('X-API-Key', apiKey)
        .send({
          label: 'Exceeds Max',
          address: baseAddress,
        });

      expect(res.status).toBe(429);
      expect(res.body.error).toContain('limit');
    });
  });

  describe('GET /api/v1/recipients - List recipients', () => {
    it('lists recipients for authenticated API key', async () => {
      const res = await request(app)
        .get('/api/v1/recipients')
        .set('X-API-Key', apiKey);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.recipients)).toBe(true);
      expect(res.body).toHaveProperty('count');
    });

    it('only returns recipients for authenticated key', async () => {
      const res1 = await request(app)
        .get('/api/v1/recipients')
        .set('X-API-Key', apiKey);

      const res2 = await request(app)
        .get('/api/v1/recipients')
        .set('X-API-Key', apiKey2);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // Each should only see their own recipients
      const ids1 = res1.body.recipients.map((r: any) => r.id);
      const ids2 = res2.body.recipients.map((r: any) => r.id);

      expect(ids1.length).not.toEqual(ids2.length);
      expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
    });
  });

  describe('GET /api/v1/recipients/:id - Get single recipient', () => {
    it('returns recipient by ID', async () => {
      const createRes = await request(app)
        .post('/api/v1/recipients')
        .set('X-API-Key', apiKey)
        .send({
          label: 'Get Test',
          address: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
        });

      expect(createRes.status).toBe(201);
      const recipientId = createRes.body.id;

      const getRes = await request(app)
        .get(`/api/v1/recipients/${recipientId}`)
        .set('X-API-Key', apiKey);

      expect(getRes.status).toBe(200);
      expect(getRes.body.id).toBe(recipientId);
      expect(getRes.body.label).toBe('Get Test');
    });

    it('prevents access to other keys\' recipients', async () => {
      const createRes = await request(app)
        .post('/api/v1/recipients')
        .set('X-API-Key', apiKey)
        .send({
          label: 'Private',
          address: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
        });

      const recipientId = createRes.body.id;

      const getRes = await request(app)
        .get(`/api/v1/recipients/${recipientId}`)
        .set('X-API-Key', apiKey2);

      expect(getRes.status).toBe(404);
    });
  });

  describe('PUT /api/v1/recipients/:id - Update recipient', () => {
    it('updates recipient label', async () => {
      const createRes = await request(app)
        .post('/api/v1/recipients')
        .set('X-API-Key', apiKey)
        .send({
          label: 'Original Label',
          address: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
        });

      const recipientId = createRes.body.id;

      const updateRes = await request(app)
        .put(`/api/v1/recipients/${recipientId}`)
        .set('X-API-Key', apiKey)
        .send({ label: 'Updated Label' });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.label).toBe('Updated Label');
    });

    it('prevents label duplication on update', async () => {
      // Create two recipients
      const res1 = await request(app)
        .post('/api/v1/recipients')
        .set('X-API-Key', apiKey)
        .send({
          label: 'First',
          address: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
        });

      const res2 = await request(app)
        .post('/api/v1/recipients')
        .set('X-API-Key', apiKey)
        .send({
          label: 'Second',
          address: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVX',
        });

      // Try to update second to have same label as first
      const updateRes = await request(app)
        .put(`/api/v1/recipients/${res2.body.id}`)
        .set('X-API-Key', apiKey)
        .send({ label: 'First' });

      expect(updateRes.status).toBe(409);
    });
  });

  describe('DELETE /api/v1/recipients/:id - Delete recipient', () => {
    it('deletes recipient', async () => {
      const createRes = await request(app)
        .post('/api/v1/recipients')
        .set('X-API-Key', apiKey)
        .send({
          label: 'To Delete',
          address: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
        });

      const recipientId = createRes.body.id;

      const deleteRes = await request(app)
        .delete(`/api/v1/recipients/${recipientId}`)
        .set('X-API-Key', apiKey);

      expect(deleteRes.status).toBe(204);

      const getRes = await request(app)
        .get(`/api/v1/recipients/${recipientId}`)
        .set('X-API-Key', apiKey);

      expect(getRes.status).toBe(404);
    });

    it('prevents deletion of other keys\' recipients', async () => {
      const createRes = await request(app)
        .post('/api/v1/recipients')
        .set('X-API-Key', apiKey)
        .send({
          label: 'Protected',
          address: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
        });

      const recipientId = createRes.body.id;

      const deleteRes = await request(app)
        .delete(`/api/v1/recipients/${recipientId}`)
        .set('X-API-Key', apiKey2);

      expect(deleteRes.status).toBe(404);
    });
  });

  describe('Using recipient ID in funding endpoint', () => {
    it('accepts recipient ID instead of raw address in funding request', async () => {
      const createRes = await request(app)
        .post('/api/v1/recipients')
        .set('X-API-Key', apiKey)
        .send({
          label: 'Funding Recipient',
          address: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
        });

      const recipientId = createRes.body.id;

      const fundRes = await request(app)
        .post('/api/v1/fund/prepare')
        .set('X-API-Key', apiKey)
        .send({
          sourceAddress: 'GBBD47UZQ5UOQCGLQDFYW5H6PYRULANXV2YNLYDUEC5XE2HHFSRONzabthjs',
          recipientId: recipientId,
          tokenAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
          amount: '1000000',
        });

      expect(fundRes.status).toBe(200);
    });

    it('rejects nonexistent recipient ID', async () => {
      const fundRes = await request(app)
        .post('/api/v1/fund/prepare')
        .set('X-API-Key', apiKey)
        .send({
          sourceAddress: 'GBBD47UZQ5UOQCGLQDFYW5H6PYRULANXV2YNLYDUEC5XE2HHFSRONZABTHJS',
          recipientId: 'nonexistent-id',
          tokenAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
          amount: '1000000',
        });

      expect(fundRes.status).toBe(404);
    });
  });
});
