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

  it('returns 409 when a request with the same key is already in flight', async () => {
    mockCacheGet.mockResolvedValue(null);
    mockCacheSetNx.mockResolvedValue(false);

    const req = makeReq({ 'x-idempotency-key': VALID_UUID });
    const { res, statusMock, jsonMock } = makeRes();
    const next = vi.fn();

    idempotencyMiddleware(req, res, next as never);
    await new Promise((r) => setTimeout(r, 20));

    expect(statusMock).toHaveBeenCalledWith(409);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'idempotency_key_in_flight' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a duplicate key with a different body with 422', async () => {
    const bodyHash = 'deadbeef';
    const stored = JSON.stringify({
      status: 201,
      body: { hash: 'abc', status: 'pending' },
      bodyHash,
    });
    mockCacheGet.mockResolvedValue(stored);

    const req = makeReq({ 'x-idempotency-key': VALID_UUID }, { amount: '999' });
    const { res, statusMock, jsonMock } = makeRes();
    const next = vi.fn();

    idempotencyMiddleware(req, res, next as never);
    await new Promise((r) => setTimeout(r, 20));

    expect(statusMock).toHaveBeenCalledWith(422);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'idempotency_key_body_mismatch' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('does not cache 5xx responses', async () => {
    mockCacheGet.mockResolvedValue(null);

    const req = makeReq({ 'x-idempotency-key': VALID_UUID });
    const { res } = makeRes();
    const next = vi.fn().mockImplementation(() => {
      res.status(500).json({ error: 'boom' });
    });

    idempotencyMiddleware(req, res, next as never);
    await new Promise((r) => setTimeout(r, 20));

    expect(mockCacheSet).not.toHaveBeenCalled();
  });

  it('scopes the cache key by API key id', async () => {
    mockCacheGet.mockResolvedValue(null);

    const req = makeReq({ 'x-idempotency-key': VALID_UUID });
    const { res } = makeRes();
    const next = vi.fn();

    idempotencyMiddleware(req, res, next as never);
    await new Promise((r) => setTimeout(r, 20));

    const keyArg = mockCacheGet.mock.calls[0][0] as string;
    expect(keyArg).toContain('key-1');
    expect(keyArg).toContain(VALID_UUID);
  });
});
