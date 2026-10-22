import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';

process.env.NODE_ENV = 'test';

const { mockCacheGet, mockCacheSet, mockCacheSetNx, mockCacheDel } = vi.hoisted(() => ({
  mockCacheGet: vi.fn(),
  mockCacheSet: vi.fn(),
  mockCacheSetNx: vi.fn(),
  mockCacheDel: vi.fn(),
}));

vi.mock('../services/cache', () => ({
  cacheGet: mockCacheGet,
  cacheSet: mockCacheSet,
  cacheSetNx: mockCacheSetNx,
  cacheDel: mockCacheDel,
}));

vi.mock('../config', () => ({
  config: {
    idempotency: { required: false },
    redis: { url: '', quoteTtlSeconds: 30, statusTtlSeconds: 10 },
  },
}));

import { idempotencyMiddleware } from '../middleware/idempotency';

const VALID_UUID = '123e4567-e89b-4d3c-a456-426614174000';

function makeReq(headers: Record<string, string> = {}, body: unknown = {}): Request {
  return {
    headers,
    body,
    apiKey: { id: 'key-1' },
    log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as Request;
}

function makeRes() {
  const jsonMock = vi.fn();
  const statusMock = vi.fn().mockReturnThis();
  const res = {
    json: jsonMock,
    status: statusMock,
    setHeader: vi.fn(),
  } as unknown as Response;
  return { res, jsonMock, statusMock };
}

describe('idempotencyMiddleware', () => {
  beforeEach(() => {
    mockCacheGet.mockReset();
    mockCacheSet.mockReset();
    mockCacheSetNx.mockReset();
    mockCacheDel.mockReset();
    mockCacheSetNx.mockResolvedValue(true);
    mockCacheSet.mockResolvedValue(undefined);
    mockCacheDel.mockResolvedValue(undefined);
  });

  it('passes through when no key and not required', async () => {
    const req = makeReq();
    const { res } = makeRes();
    const next = vi.fn();
    mockCacheGet.mockResolvedValue(null);

    idempotencyMiddleware(req, res, next as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects invalid UUID format with 400', () => {
    const req = makeReq({ 'x-idempotency-key': 'not-a-uuid' });
    const { res, statusMock, jsonMock } = makeRes();
    const next = vi.fn();

    idempotencyMiddleware(req, res, next as never);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'invalid_idempotency_key' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns cached response on duplicate key', async () => {
    const stored = JSON.stringify({
      status: 201,
      body: { hash: 'abc', status: 'pending' },
      bodyHash: expect.any(String),
    });
    mockCacheGet.mockResolvedValue(stored);

    const req = makeReq({ 'x-idempotency-key': VALID_UUID });
    const { res, statusMock, jsonMock } = makeRes();
    const next = vi.fn();

    idempotencyMiddleware(req, res, next as never);
    await new Promise((r) => setTimeout(r, 20));

    expect(statusMock).toHaveBeenCalledWith(201);
    expect(jsonMock).toHaveBeenCalledWith({ hash: 'abc', status: 'pending' });
    expect(res.setHeader).toHaveBeenCalledWith('Idempotent-Replayed', 'true');
    expect(next).not.toHaveBeenCalled();
  });

  it('proceeds on first request with valid key', async () => {
    mockCacheGet.mockResolvedValue(null);

    const req = makeReq({ 'x-idempotency-key': VALID_UUID });
    const { res } = makeRes();
    const next = vi.fn();

    idempotencyMiddleware(req, res, next as never);
    await new Promise((r) => setTimeout(r, 20));

    expect(next).toHaveBeenCalledOnce();
  });

  it('sets Idempotent-Replayed: false on first response', async () => {
    mockCacheGet.mockResolvedValue(null);

    const req = makeReq({ 'x-idempotency-key': VALID_UUID });
    const { res } = makeRes();
    const next = vi.fn().mockImplementation(() => {
      res.json({ ok: true });
    });

    idempotencyMiddleware(req, res, next as never);
    await new Promise((r) => setTimeout(r, 20));

    expect(res.setHeader).toHaveBeenCalledWith('Idempotent-Replayed', 'false');
  });

  it('does not replay a cached response for a different idempotency key', async () => {
    const stored = JSON.stringify({ status: 201, body: { hash: 'abc', status: 'pending' } });
    mockCacheGet.mockImplementation(async (key: string) =>
      key.includes(VALID_UUID) ? stored : null,
    );
    mockCacheSet.mockResolvedValue(undefined);

    const otherKey = '223e4567-e89b-4d3c-a456-426614174000';
    const req = makeReq({ 'x-idempotency-key': otherKey });
    const { res, statusMock } = makeRes();
    const next = vi.fn();

    idempotencyMiddleware(req, res, next as never);
    await new Promise((r) => setTimeout(r, 20));

    expect(statusMock).not.toHaveBeenCalledWith(201);
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not cache a failed (5xx) response for replay', async () => {
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);

    const req = makeReq({ 'x-idempotency-key': VALID_UUID });
    const { res } = makeRes();
    const next = vi.fn().mockImplementation(() => {
      res.status(502).json({ error: 'exchange_unavailable' });
    });

    idempotencyMiddleware(req, res, next as never);
    await new Promise((r) => setTimeout(r, 20));

    expect(mockCacheSet).not.toHaveBeenCalled();
  });
});
