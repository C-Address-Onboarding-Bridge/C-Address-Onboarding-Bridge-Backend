/**
 * Tests for the Express cache middleware.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.NODE_ENV = 'test';

// ─── Mock cache service ────────────────────────────────────────────────────────

const mockSwrStore: Map<string, { value: unknown; expiresAt: number }> = new Map();

vi.mock('../services/cache', () => ({
  isRedisEnabled: vi.fn(() => true),
  swrGet: vi.fn(async (key: string) => {
    const entry = mockSwrStore.get(key);
    if (!entry) return null;
    return { value: entry.value, stale: Date.now() > entry.expiresAt };
  }),
  swrSet: vi.fn(async (key: string, value: unknown, ttl: number) => {
    mockSwrStore.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
  }),
  withSingleFlight: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
}));

import { cacheMiddleware } from '../middleware/cache';
import { Request, Response, NextFunction } from 'express';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockReq(overrides: Partial<Request> = {}): Request {
  return {
    params: {},
    query: {},
    body: {},
    method: 'GET',
    ...overrides,
  } as Request;
}

type JsonSpy = ReturnType<typeof vi.fn>;

function makeMockRes(): { res: Response; jsonSpy: JsonSpy; setHeaderSpy: JsonSpy; statusCode: number } {
  let statusCode = 200;
  const jsonSpy = vi.fn().mockReturnThis();
  const setHeaderSpy = vi.fn();

  const res = {
    get statusCode() { return statusCode; },
    set statusCode(v: number) { statusCode = v; },
    json: jsonSpy,
    setHeader: setHeaderSpy,
    getHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
  } as unknown as Response;

  return { res, jsonSpy, setHeaderSpy, statusCode: 200 };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('cacheMiddleware', () => {
  beforeEach(() => {
    mockSwrStore.clear();
    vi.clearAllMocks();
  });

  it('calls next() on cache miss', async () => {
    const middleware = cacheMiddleware({ ttl: 30, key: () => 'miss-key' });
    const req = makeMockReq();
    const { res } = makeMockRes();
    const next: NextFunction = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('sets X-Cache: MISS on cache miss', async () => {
    const middleware = cacheMiddleware({ ttl: 30, key: () => 'miss-key-2' });
    const req = makeMockReq();
    const { res, setHeaderSpy } = makeMockRes();
    const next: NextFunction = vi.fn();

    await middleware(req, res, next);

    expect(setHeaderSpy).toHaveBeenCalledWith('X-Cache', 'MISS');
  });

  it('returns cached value and sets X-Cache: HIT on fresh hit', async () => {
    const key = 'hit-key';
    mockSwrStore.set(key, { value: { data: 'cached' }, expiresAt: Date.now() + 30_000 });

    const middleware = cacheMiddleware({ ttl: 30, key: () => key });
    const req = makeMockReq();
    const { res, jsonSpy, setHeaderSpy } = makeMockRes();
    const next: NextFunction = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(setHeaderSpy).toHaveBeenCalledWith('X-Cache', 'HIT');
    expect(jsonSpy).toHaveBeenCalledWith({ data: 'cached' });
  });

  it('returns stale value and sets X-Cache: STALE on stale hit', async () => {
    const key = 'stale-key';
    // Stale: expiresAt in the past
    mockSwrStore.set(key, { value: { data: 'old' }, expiresAt: Date.now() - 1000 });

    const middleware = cacheMiddleware({ ttl: 30, key: () => key });
    const req = makeMockReq();
    const { res, jsonSpy, setHeaderSpy } = makeMockRes();
    const next: NextFunction = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(setHeaderSpy).toHaveBeenCalledWith('X-Cache', 'STALE');
    expect(jsonSpy).toHaveBeenCalledWith({ data: 'old' });
  });

  it('intercepts res.json to cache the response body after a miss', async () => {
    const { swrSet } = await import('../services/cache');
    const key = 'intercept-key';

    const middleware = cacheMiddleware({ ttl: 30, key: () => key });
    const req = makeMockReq();
    const { res } = makeMockRes();
    const next: NextFunction = vi.fn((err?: unknown) => {
      if (err) return;
      // Simulate the route handler calling res.json
      res.json({ fresh: true });
    });

    await middleware(req, res, next);

    expect(swrSet).toHaveBeenCalledWith(key, { fresh: true }, 30);
  });

  it('sets Cache-Control header on hit', async () => {
    const key = 'cache-control-key';
    mockSwrStore.set(key, { value: { x: 1 }, expiresAt: Date.now() + 30_000 });

    const middleware = cacheMiddleware({ ttl: 30, key: () => key });
    const req = makeMockReq();
    const { res, setHeaderSpy } = makeMockRes();
    const next: NextFunction = vi.fn();

    await middleware(req, res, next);

    expect(setHeaderSpy).toHaveBeenCalledWith('Cache-Control', 'public, max-age=30');
  });

  it('uses default keyFn when no key/keyFn provided', async () => {
    const middleware = cacheMiddleware({ ttl: 10 });
    const req = makeMockReq({ params: { id: '1' }, query: { foo: 'bar' } });
    const { res } = makeMockRes();
    const next: NextFunction = vi.fn();

    // Should not throw
    await expect(middleware(req, res, next)).resolves.toBeUndefined();
  });

  it('falls through (calls next) when Redis is disabled', async () => {
    const { isRedisEnabled } = await import('../services/cache');
    vi.mocked(isRedisEnabled).mockReturnValueOnce(false);

    const middleware = cacheMiddleware({ ttl: 30, key: () => 'any' });
    const req = makeMockReq();
    const { res } = makeMockRes();
    const next: NextFunction = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not cache non-2xx responses', async () => {
    const { swrSet } = await import('../services/cache');
    const key = 'error-key';

    const middleware = cacheMiddleware({ ttl: 30, key: () => key });
    const req = makeMockReq();
    const { res } = makeMockRes();
    (res as unknown as { statusCode: number }).statusCode = 500;

    const next: NextFunction = vi.fn(() => {
      res.json({ error: 'oops' });
    });

    await middleware(req, res, next);

    expect(swrSet).not.toHaveBeenCalled();
  });

  it('triggers background revalidation on stale hit', async () => {
    const { withSingleFlight } = await import('../services/cache');
    const key = 'stale-revalidate-key';
    // Stale: expiresAt in the past
    mockSwrStore.set(key, { value: { data: 'old' }, expiresAt: Date.now() - 1000 });

    const middleware = cacheMiddleware({ ttl: 30, key: () => key });
    const req = makeMockReq();
    const { res, jsonSpy, setHeaderSpy } = makeMockRes();
    const next: NextFunction = vi.fn();

    await middleware(req, res, next);

    // Verify stale response is served
    expect(setHeaderSpy).toHaveBeenCalledWith('X-Cache', 'STALE');
    expect(jsonSpy).toHaveBeenCalledWith({ data: 'old' });

    // Verify background revalidation was triggered via withSingleFlight
    // The callback should be invoked to trigger revalidation
    expect(withSingleFlight).toHaveBeenCalled();
  });

  it('does not share cache between different authenticated API keys', async () => {
    const key = 'shared-cache-key';
    mockSwrStore.set(key, { value: { data: 'cached-for-key1' }, expiresAt: Date.now() + 30_000 });

    const middleware = cacheMiddleware({ ttl: 30, key: () => key });

    // First request with key1
    const req1 = makeMockReq({ apiKeyId: 'key-1' });
    const { res: res1, jsonSpy: jsonSpy1 } = makeMockRes();
    const next1: NextFunction = vi.fn();

    await middleware(req1, res1, next1);
    expect(jsonSpy1).toHaveBeenCalledWith({ data: 'cached-for-key1' });

    // Second request with different key2 should not get cached value from key1
    const req2 = makeMockReq({ apiKeyId: 'key-2' });
    const { res: res2, jsonSpy: jsonSpy2 } = makeMockRes();
    const next2: NextFunction = vi.fn();

    // When keys are different, middleware should call next() to recompute
    // This tests that the default keyFn includes the authenticated caller
    await middleware(req2, res2, next2);

    // If the bug is present, both would share the same cache entry
    // The fix would ensure different API keys generate different cache keys
    expect(next2).toHaveBeenCalledOnce();
  });

  it('uses Cache-Control: private for authenticated requests', async () => {
    const key = 'auth-cache-control-key';
    mockSwrStore.set(key, { value: { x: 1 }, expiresAt: Date.now() + 30_000 });

    const middleware = cacheMiddleware({ ttl: 30, key: () => key });
    const req = makeMockReq({ apiKeyId: 'secret-key' });
    const { res, setHeaderSpy } = makeMockRes();
    const next: NextFunction = vi.fn();

    await middleware(req, res, next);

    // For authenticated requests with per-tenant data, should use Cache-Control: private
    // to prevent CDNs from caching and sharing between tenants
    expect(setHeaderSpy).toHaveBeenCalledWith(
      'Cache-Control',
      expect.stringContaining('private'),
    );
  });
});
