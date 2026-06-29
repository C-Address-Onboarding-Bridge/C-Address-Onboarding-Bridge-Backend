import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
process.env.BRIDGE_FEE_BPS = '30';
process.env.API_KEYS = 'test-api-key-123';

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  json: vi.fn().mockResolvedValue({}),
  text: vi.fn().mockResolvedValue('ok'),
}));

let maskValue: (val: string) => string;
let maskHeaders: (h: Record<string, string | string[] | undefined>) => Record<string, unknown>;
let maskBody: (body: unknown, depth?: number) => unknown;
let app: import('express').Express;

beforeAll(async () => {
  const loggingMod = await import('../middleware/logging');
  maskValue = loggingMod.maskValue;
  maskHeaders = loggingMod.maskHeaders;
  maskBody = loggingMod.maskBody;

  const indexMod = await import('../index');
  app = indexMod.app;
});

describe('PII masking', () => {
  describe('maskValue', () => {
    it('returns *** for very short values', () => {
      expect(maskValue('abc')).toBe('***');
      expect(maskValue('')).toBe('***');
    });

    it('keeps last 4 chars and masks the rest', () => {
      expect(maskValue('my-secret-api-key')).toBe('***-key');
      expect(maskValue('abcdefgh')).toBe('***efgh');
      expect(maskValue('1234')).toBe('***');
    });
  });

  describe('maskHeaders', () => {
    it('masks x-api-key header', () => {
      const result = maskHeaders({ 'x-api-key': 'my-secret-key-1234' });
      expect(result['x-api-key']).toBe('***1234');
    });

    it('masks authorization header', () => {
      const result = maskHeaders({ authorization: 'Bearer my-token-5678' });
      expect(result['authorization']).toBe('***5678');
    });

    it('passes through non-sensitive headers', () => {
      const result = maskHeaders({ 'content-type': 'application/json', 'x-request-id': 'abc123' });
      expect(result['content-type']).toBe('application/json');
      expect(result['x-request-id']).toBe('abc123');
    });

    it('handles array header values', () => {
      const result = maskHeaders({ 'x-api-key': ['my-secret-key-1234', 'other'] });
      expect(result['x-api-key']).toBe('***1234');
    });
  });

  describe('maskBody', () => {
    it('masks known sensitive fields', () => {
      const body = { apiKey: 'secret-api-key-1234', name: 'test' };
      const result = maskBody(body) as Record<string, unknown>;
      expect(result['apiKey']).toBe('***1234');
      expect(result['name']).toBe('test');
    });

    it('masks email field', () => {
      const body = { email: 'user@example.com', amount: '1000' };
      const result = maskBody(body) as Record<string, unknown>;
      expect((result['email'] as string).startsWith('***')).toBe(true);
      expect(result['amount']).toBe('1000');
    });

    it('masks password field', () => {
      const body = { password: 'super-secret-password' };
      const result = maskBody(body) as Record<string, unknown>;
      expect((result['password'] as string).startsWith('***')).toBe(true);
    });

    it('masks walletAddress field', () => {
      const body = { walletAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW' };
      const result = maskBody(body) as Record<string, unknown>;
      expect((result['walletAddress'] as string).startsWith('***')).toBe(true);
    });

    it('does not mutate primitive values', () => {
      expect(maskBody(null)).toBe(null);
      expect(maskBody(undefined)).toBe(undefined);
      expect(maskBody(42)).toBe(42);
      expect(maskBody('plain string')).toBe('plain string');
    });

    it('handles nested objects', () => {
      const body = { user: { email: 'user@example.com', name: 'Alice' } };
      const result = maskBody(body) as Record<string, Record<string, unknown>>;
      expect((result['user']['email'] as string).startsWith('***')).toBe(true);
      expect(result['user']['name']).toBe('Alice');
    });

    it('handles arrays', () => {
      const body = [{ apiKey: 'secret1234' }, { apiKey: 'other5678' }];
      const result = maskBody(body) as Array<Record<string, unknown>>;
      expect((result[0]['apiKey'] as string).startsWith('***')).toBe(true);
      expect((result[1]['apiKey'] as string).startsWith('***')).toBe(true);
    });
  });

  describe('loggingMiddleware integration', () => {
    it('does not break the health endpoint', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('does not break API endpoints', async () => {
      const res = await request(app)
        .get('/api/v1/quote')
        .query({
          sourceAsset: 'XLM',
          amount: '1000',
          targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
        })
        .set('X-API-Key', 'test-api-key-123');
      expect(res.status).toBe(200);
    });
  });
});
