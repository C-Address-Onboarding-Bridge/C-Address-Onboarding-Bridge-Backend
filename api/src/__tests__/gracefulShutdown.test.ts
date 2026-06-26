import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

process.env.NODE_ENV = 'test';
process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
process.env.BRIDGE_FEE_BPS = '30';
process.env.API_KEYS = 'test-api-key-123';

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  json: vi.fn().mockResolvedValue({}),
  text: vi.fn().mockResolvedValue('ok'),
}));

import { GracefulShutdown } from '../shutdown';

describe('Graceful Shutdown', () => {
  describe('GracefulShutdown class', () => {
    it('starts not shutting down', () => {
      const gs = new GracefulShutdown(100);
      expect(gs.shuttingDown).toBe(false);
      expect(gs.requestCount).toBe(0);
    });

    it('tracks request count correctly', () => {
      const gs = new GracefulShutdown(100);
      gs.increment();
      gs.increment();
      expect(gs.requestCount).toBe(2);
      gs.decrement();
      expect(gs.requestCount).toBe(1);
    });

    it('decrement never goes below zero', () => {
      const gs = new GracefulShutdown(100);
      gs.decrement();
      expect(gs.requestCount).toBe(0);
    });

    it('sets shuttingDown flag immediately on shutdown()', async () => {
      const gs = new GracefulShutdown(100);
      const p = gs.shutdown();
      expect(gs.shuttingDown).toBe(true);
      await p;
    });

    it('resolves immediately when no active requests', async () => {
      const gs = new GracefulShutdown(100);
      await expect(gs.shutdown()).resolves.toBeUndefined();
    });

    it('resolves when active requests drain to zero', async () => {
      const gs = new GracefulShutdown(2000);
      gs.increment();
      const p = gs.shutdown();
      expect(gs.shuttingDown).toBe(true);
      setTimeout(() => gs.decrement(), 50);
      await expect(p).resolves.toBeUndefined();
    }, 3000);

    it('force-exits after timeout when requests do not drain', async () => {
      const gs = new GracefulShutdown(120);
      gs.increment(); // never decremented
      const start = Date.now();
      await gs.shutdown();
      expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    }, 1000);

    it('second shutdown() call is a no-op', async () => {
      const gs = new GracefulShutdown(100);
      await gs.shutdown();
      await expect(gs.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('/health endpoint', () => {
    it('returns 200 and ok status when healthy', async () => {
      const { app } = await import('../index');
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body).toHaveProperty('timestamp');
      expect(res.body).toHaveProperty('circuits');
    });

    it('returns 503 during shutdown (bypassing requestTracker)', async () => {
      const { app } = await import('../index');
      const shutdownMod = await import('../shutdown');
      const original = shutdownMod.gracefulShutdown.isShuttingDown;
      shutdownMod.gracefulShutdown.isShuttingDown = true;
      try {
        const res = await request(app).get('/health');
        expect(res.status).toBe(503);
        expect(res.body.status).toBe('shutting_down');
      } finally {
        shutdownMod.gracefulShutdown.isShuttingDown = original;
      }
    });
  });

  describe('requestTracker middleware', () => {
    it('allows requests when not shutting down', async () => {
      const gs = new GracefulShutdown(100);
      // Build a mini-app that uses a custom graceful shutdown instance
      const testApp = express();

      // Inline the middleware logic with our test gs instance
      testApp.use((_req, res, next) => {
        if (gs.shuttingDown) {
          res.set('Connection', 'close');
          res.status(503).json({ error: 'service_unavailable', message: 'server is shutting down' });
          return;
        }
        gs.increment();
        let released = false;
        const release = () => { if (!released) { released = true; gs.decrement(); } };
        res.on('finish', release);
        res.on('close', release);
        next();
      });
      testApp.get('/ping', (_req, res) => res.json({ ok: true }));

      const res = await request(testApp).get('/ping');
      expect(res.status).toBe(200);
      expect(gs.requestCount).toBe(0); // decremented on finish
    });

    it('blocks requests and returns 503 when shutting down', async () => {
      const gs = new GracefulShutdown(100);
      await gs.shutdown(); // immediately shuts down (no active requests)

      const testApp = express();
      testApp.use((_req, res, next) => {
        if (gs.shuttingDown) {
          res.set('Connection', 'close');
          res.status(503).json({ error: 'service_unavailable', message: 'server is shutting down' });
          return;
        }
        gs.increment();
        let released = false;
        const release = () => { if (!released) { released = true; gs.decrement(); } };
        res.on('finish', release);
        res.on('close', release);
        next();
      });
      testApp.get('/ping', (_req, res) => res.json({ ok: true }));

      const res = await request(testApp).get('/ping');
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('service_unavailable');
    });
  });
});
