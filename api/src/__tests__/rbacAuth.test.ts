import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';

process.env.NODE_ENV = 'test';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createApiKey,
  revokeApiKey,
  listApiKeys,
  updateApiKey,
  rbacAuth,
  requireScopes,
  seedLegacyKeys,
} from '../middleware/rbacAuth';

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: '127.0.0.1',
    path: '/api/test',
    method: 'GET',
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, status, json };
}

describe('createApiKey / rbacAuth', () => {
  it('creates a key and allows valid request', () => {
    const { rawKey } = createApiKey({
      name: 'test-key',
      createdBy: 'test',
      scopes: ['quote:read', 'status:read'],
    });

    const req = mockReq({ headers: { 'x-api-key': rawKey } });
    const { res } = mockRes();
    const next = vi.fn();

    rbacAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.apiKeyRecord?.name).toBe('test-key');
    expect(req.apiKeyRecord?.scopes).toContain('quote:read');
  });

  it('rejects missing API key', () => {
    const req = mockReq({ headers: {} });
    const { res, status } = mockRes();
    const next = vi.fn();

    rbacAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('rejects invalid API key', () => {
    const req = mockReq({ headers: { 'x-api-key': 'cab_nonexistentkey0000000000000000000' } });
    const { res, status } = mockRes();
    const next = vi.fn();

    rbacAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('rejects revoked key', () => {
    const { rawKey, record } = createApiKey({ name: 'revoke-me', createdBy: 'test', scopes: ['quote:read'] });
    revokeApiKey(record.id);

    const req = mockReq({ headers: { 'x-api-key': rawKey } });
    const { res, status } = mockRes();
    const next = vi.fn();

    rbacAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('rejects expired key', () => {
    const { rawKey } = createApiKey({
      name: 'expired-key',
      createdBy: 'test',
      scopes: ['quote:read'],
      expiresAt: Date.now() - 1000,
    });

    const req = mockReq({ headers: { 'x-api-key': rawKey } });
    const { res, status } = mockRes();
    const next = vi.fn();

    rbacAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('accepts non-expired key', () => {
    const { rawKey } = createApiKey({
      name: 'valid-expiry',
      createdBy: 'test',
      scopes: ['quote:read'],
      expiresAt: Date.now() + 60_000,
    });

    const req = mockReq({ headers: { 'x-api-key': rawKey } });
    const { res } = mockRes();
    const next = vi.fn();

    rbacAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects IP not in whitelist', () => {
    const { rawKey } = createApiKey({
      name: 'ip-restricted',
      createdBy: 'test',
      scopes: ['quote:read'],
      ipWhitelist: ['192.168.1.0/24'],
    });

    const req = mockReq({ ip: '10.0.0.1', headers: { 'x-api-key': rawKey } });
    const { res, status } = mockRes();
    const next = vi.fn();

    rbacAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it('accepts IP within CIDR whitelist', () => {
    const { rawKey } = createApiKey({
      name: 'ip-cidr',
      createdBy: 'test',
      scopes: ['quote:read'],
      ipWhitelist: ['192.168.1.0/24'],
    });

    const req = mockReq({ ip: '192.168.1.50', headers: { 'x-api-key': rawKey } });
    const { res } = mockRes();
    const next = vi.fn();

    rbacAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('requireScopes', () => {
  it('allows request when scopes match', () => {
    const { rawKey } = createApiKey({ name: 'scoped', createdBy: 'test', scopes: ['fund:write', 'quote:read'] });
    const req = mockReq({ headers: { 'x-api-key': rawKey } });
    const { res } = mockRes();
    const authNext = vi.fn();
    rbacAuth(req, res, authNext);

    const next = vi.fn();
    const { res: res2 } = mockRes();
    requireScopes('fund:write')(req, res2, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects request when scope is missing', () => {
    const { rawKey } = createApiKey({ name: 'readonly', createdBy: 'test', scopes: ['quote:read'] });
    const req = mockReq({ headers: { 'x-api-key': rawKey } });
    const { res } = mockRes();
    rbacAuth(req, res, vi.fn() as unknown as Parameters<typeof rbacAuth>[2]);

    const next = vi.fn();
    const { res: res2, status } = mockRes();
    requireScopes('fund:write')(req, res2, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });
});

describe('listApiKeys / updateApiKey', () => {
  it('lists keys without exposing keyHash', () => {
    createApiKey({ name: 'list-test', createdBy: 'test', scopes: ['status:read'] });
    const keys = listApiKeys();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0]).not.toHaveProperty('keyHash');
  });

  it('updates key name and scopes', () => {
    const { record } = createApiKey({ name: 'updatable', createdBy: 'test', scopes: ['status:read'] });
    const updated = updateApiKey(record.id, { name: 'updated-name', scopes: ['cex:read'] });
    expect(updated).toBe(true);
    const keys = listApiKeys();
    const found = keys.find((k) => k.id === record.id);
    expect(found?.name).toBe('updated-name');
    expect(found?.scopes).toContain('cex:read');
  });
});

describe('seedLegacyKeys', () => {
  it('seeds a plain API key and allows rbacAuth to accept it', () => {
    const legacyKey = 'legacy-plain-key-' + Date.now();
    seedLegacyKeys([legacyKey]);

    const req = mockReq({ headers: { 'x-api-key': legacyKey } });
    const { res } = mockRes();
    const next = vi.fn();

    rbacAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not duplicate seed on second call', () => {
    const legacyKey = 'legacy-dedup-' + Date.now();
    seedLegacyKeys([legacyKey]);
    const countBefore = listApiKeys().length;
    seedLegacyKeys([legacyKey]);
    expect(listApiKeys().length).toBe(countBefore);
  });
});
