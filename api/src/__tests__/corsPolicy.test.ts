import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import cors from 'cors';
import request from 'supertest';
import { resolveCorsOrigin } from '../index';

describe('CORS policy resolution and default origins (#655)', () => {
  it('defaults to no allowed origins (false) when corsOrigins is empty', () => {
    const origin = resolveCorsOrigin([], 'development');
    expect(origin).toBe(false);

    const prodOrigin = resolveCorsOrigin([], 'production');
    expect(prodOrigin).toBe(false);
  });

  it('allows wildcard (*) only when explicitly configured and not in production', () => {
    const devOrigin = resolveCorsOrigin(['*'], 'development');
    expect(devOrigin).toBe('*');

    const testOrigin = resolveCorsOrigin(['*'], 'test');
    expect(testOrigin).toBe('*');
  });

  it('never allows wildcard (*) in production even if configured', () => {
    const prodOrigin = resolveCorsOrigin(['*'], 'production');
    expect(prodOrigin).toBe(false);

    const mixedOrigin = resolveCorsOrigin(['*', 'https://app.example.com'], 'production');
    expect(mixedOrigin).toEqual(['https://app.example.com']);
  });

  it('allows explicitly configured origins in any environment', () => {
    const origins = ['https://app.example.com', 'https://bridge.stellar.org'];
    expect(resolveCorsOrigin(origins, 'production')).toEqual(origins);
    expect(resolveCorsOrigin(origins, 'development')).toEqual(origins);
  });

  it('does not send Access-Control-Allow-Origin header when origins are unset', async () => {
    const originPolicy = resolveCorsOrigin([], 'production');
    const testApp = express();
    testApp.use(cors({ origin: originPolicy }));
    testApp.get('/test', (_req, res) => res.json({ ok: true }));

    const res = await request(testApp)
      .get('/test')
      .set('Origin', 'https://attacker.example.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
