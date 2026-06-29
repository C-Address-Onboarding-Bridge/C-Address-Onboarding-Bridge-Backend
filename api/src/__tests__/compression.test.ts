import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

process.env.NODE_ENV = 'test';
process.env.API_KEYS = 'test-api-key-123';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../config', () => ({
  config: {
    compression: { threshold: 512, level: 6 },
    soroban: {
      rpcUrls: ['https://soroban-rpc.testnet.stellar.org'],
      networkPassphrase: 'Test SDF Network ; September 2015',
      bridgeContractId: '',
      feeBps: 30,
      rpc: { healthCheckIntervalMs: 30000, failureThreshold: 3, recoveryIntervalMs: 60000, selectionStrategy: 'round-robin' as const },
    },
    moonpay: { apiKey: '', secretKey: '' },
    transak: { apiKey: '', environment: 'STAGING', webhookSecret: '' },
    apiKeys: ['test-api-key-123'],
    logLevel: 'silent',
    rateLimit: { redisEnabled: false, windowMs: 60000, burstFactor: 2 },
    rbac: { enabled: true },
  },
}));

import { compressionMiddleware } from '../middleware/compression';

function buildApp(bodySize: number): express.Express {
  const app = express();
  app.use(compressionMiddleware);
  app.get('/large', (_req, res) => {
    const payload = JSON.stringify({ data: 'x'.repeat(bodySize) });
    res.setHeader('Content-Type', 'application/json');
    res.send(payload);
  });
  app.get('/small', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('compression middleware', () => {
  it('compresses responses larger than threshold when client accepts gzip', async () => {
    const app = buildApp(1024);
    const res = await request(app).get('/large').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('does not compress small responses below threshold', async () => {
    const app = buildApp(10);
    const res = await request(app).get('/small').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('serves uncompressed when client does not accept encoding', async () => {
    const app = buildApp(2048);
    const res = await request(app).get('/large').set('Accept-Encoding', 'identity');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('skips already-compressed image content type', async () => {
    const appWithImage = express();
    appWithImage.use(compressionMiddleware);
    appWithImage.get('/img', (_req, res) => {
      res.setHeader('Content-Type', 'image/png');
      res.send(Buffer.alloc(2048, 0xff));
    });

    const res = await request(appWithImage).get('/img').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
