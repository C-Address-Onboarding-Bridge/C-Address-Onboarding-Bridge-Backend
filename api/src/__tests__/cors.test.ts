import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
process.env.BRIDGE_FEE_BPS = '30';
process.env.API_KEYS = 'test-api-key-123';
process.env.CORS_ORIGINS = 'https://app.example.com,https://admin.example.com';

let app: import('express').Express;

beforeAll(async () => {
  const mod = await import('../index');
  app = mod.app;
});

describe('CORS origin allowlist', () => {
  it('allows a configured origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://app.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it('does not reflect a disallowed origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects preflight from a disallowed origin', async () => {
    const res = await request(app)
      .options('/api/quote')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('only advertises GET and POST methods in preflight', async () => {
    const res = await request(app)
      .options('/api/quote')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST');
  });
});
