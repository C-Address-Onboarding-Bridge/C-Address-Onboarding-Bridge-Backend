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

let app: import('express').Express;

beforeAll(async () => {
  const mod = await import('../index');
  app = mod.app;
});

describe('OpenAPI Documentation', () => {
  it('GET /api/openapi.json returns a valid OpenAPI 3.1 spec', async () => {
    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.info.title).toBeTruthy();
    expect(res.body.paths).toBeDefined();
  });

  it('openapi.json documents the quote endpoint', async () => {
    const res = await request(app).get('/api/openapi.json');
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths['/api/v2/quote']).toBeDefined();
  });

  it('openapi.json documents the fund endpoint', async () => {
    const res = await request(app).get('/api/openapi.json');
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths['/api/v2/fund']).toBeDefined();
  });

  it('openapi.json documents the status endpoint', async () => {
    const res = await request(app).get('/api/openapi.json');
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths['/api/v2/status/{txHash}']).toBeDefined();
  });

  it('openapi.json documents the offramp endpoints', async () => {
    const res = await request(app).get('/api/openapi.json');
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths['/api/v2/offramp/moonpay']).toBeDefined();
    expect(paths['/api/v2/offramp/transak']).toBeDefined();
  });

  it('openapi.json documents the CEX route endpoint', async () => {
    const res = await request(app).get('/api/openapi.json');
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths['/api/v2/cex/route']).toBeDefined();
  });

  it('openapi.json documents the health endpoint', async () => {
    const res = await request(app).get('/api/openapi.json');
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths['/health']).toBeDefined();
  });

  it('openapi.json documents API key management', async () => {
    const res = await request(app).get('/api/openapi.json');
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths['/api/v1/keys']).toBeDefined();
  });

  it('openapi.json has ApiKeyAuth security scheme', async () => {
    const res = await request(app).get('/api/openapi.json');
    expect(res.body.components?.securitySchemes?.ApiKeyAuth).toBeDefined();
    expect(res.body.components.securitySchemes.ApiKeyAuth.in).toBe('header');
    expect(res.body.components.securitySchemes.ApiKeyAuth.name).toBe('X-API-Key');
  });

  it('GET /api/docs returns swagger UI html', async () => {
    const res = await request(app).get('/api/docs');
    expect([200, 301]).toContain(res.status);
  });
});
