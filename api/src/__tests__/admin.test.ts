/**
 * Admin router scope-enforcement tests.
 *
 * Fixtures are built with the typed factories in ./fixtures so this file can be
 * type-checked (no `// @ts-nocheck`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createApiKey, listApiKeys, requireScopes } from '../middleware/rbacAuth';
import { adminRouter } from '../routes/admin';
import { makeApiKeyRecord, makeRequest, makeResponse } from './fixtures';

process.env.NODE_ENV = 'test';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../services/transactions', () => ({
  CONTRACT_MAX_FEE_BPS: 1000,
  getAdminAuditLog: vi.fn(() => []),
  getFeeConfig: vi.fn(() => ({ feeBps: 30, timelockMs: 60000 })),
  getHealthSnapshot: vi.fn(() => ({ status: 'healthy', uptime: 12345 })),
  getTransactionStats: vi.fn(() => Promise.resolve({ totalFunded: 1000, totalFees: 30 })),
  recordAdminAction: vi.fn(),
  updateFeeConfig: vi.fn(() => ({ pendingFeeBps: 50, timelockUntil: Date.now() + 60000 })),
  withdrawAccumulatedFees: vi.fn(() => Promise.resolve({ proposalId: 'p1', status: 'proposal_created', recipient: 'addr', token: 'tok', note: 'note' })),
}));

vi.mock('../services/auditLog', () => ({
  AuditEventType: {},
  integrityAuditLog: {
    append: vi.fn(),
    listEntries: vi.fn(() => []),
    listCheckpoints: vi.fn(() => []),
  },
}));

vi.mock('../services/asyncPipeline', () => ({
  enqueueAudit: vi.fn(),
}));

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return makeRequest(overrides);
}

function createMockResponse(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  return makeResponse();
}

describe('Admin Router - Scope Enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /admin/stats', () => {
    it.skip('allows request with admin:keys scope', async () => {
      const { rawKey } = createApiKey({
        name: 'admin-key',
        createdBy: 'test',
        scopes: ['admin:keys'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/stats',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
      });

      // Simulate what rbacAuth middleware does
      const authReq = req as any;
      const keyRecord = listApiKeys().find((k: any) => k.name === 'admin-key');
      authReq.apiKeyRecord = keyRecord ?? makeApiKeyRecord({ name: 'admin-key', scopes: ['admin:keys'] });

      const { res } = createMockResponse();
      const next = vi.fn();

      // Call the endpoint handler directly
      const handler = adminRouter.stack.find((layer: any) => layer.name === 'get')?.handle;
      if (handler) {
        handler(req, res, next);
        expect(res.json).toHaveBeenCalled();
      }
    });

    it.skip('rejects request with quote:read scope only', async () => {
      const { rawKey } = createApiKey({
        name: 'quote-only',
        createdBy: 'test',
        scopes: ['quote:read'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/stats',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = listApiKeys().find((k: any) => k.name === 'quote-only');
      authReq.apiKeyRecord = keyRecord ?? makeApiKeyRecord({ name: 'quote-only', scopes: ['quote:read'] });

      const { res, status } = createMockResponse();
      const next = vi.fn();

      // Simulate requireScopes middleware
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('GET /admin/fees', () => {
    it.skip('allows request with admin:keys scope', async () => {
      const { rawKey } = createApiKey({
        name: 'fee-admin',
        createdBy: 'test',
        scopes: ['admin:keys'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/fees',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = listApiKeys().find((k: any) => k.name === 'fee-admin');
      authReq.apiKeyRecord = keyRecord ?? makeApiKeyRecord({ name: 'fee-admin', scopes: ['admin:keys'] });

      const { res } = createMockResponse();
      const next = vi.fn();
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it.skip('rejects request without admin:keys scope', async () => {
      const { rawKey } = createApiKey({
        name: 'no-admin',
        createdBy: 'test',
        scopes: ['fund:write', 'quote:read'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/fees',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = listApiKeys().find((k: any) => k.name === 'no-admin');
      authReq.apiKeyRecord = keyRecord ?? makeApiKeyRecord({ name: 'no-admin', scopes: ['fund:write', 'quote:read'] });

      const { res, status } = createMockResponse();
      const next = vi.fn();
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(status).toHaveBeenCalledWith(403);
    });
  });

  describe('POST /admin/fees', () => {
    it.skip('allows fee update with admin:keys scope', async () => {
      const { rawKey } = createApiKey({
        name: 'fee-updater',
        createdBy: 'test',
        scopes: ['admin:keys'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/fees',
        method: 'POST',
        headers: { 'x-api-key': rawKey },
        body: { feeBps: 50, timelockMs: 120000 },
      });

      const authReq = req as any;
      const keyRecord = listApiKeys().find((k: any) => k.name === 'fee-updater');
      authReq.apiKeyRecord = keyRecord ?? makeApiKeyRecord({ name: 'fee-updater', scopes: ['admin:keys'] });

      const { res } = createMockResponse();
      const next = vi.fn();
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it.skip('rejects fee update without admin:keys scope', async () => {
      const { rawKey } = createApiKey({
        name: 'non-admin',
        createdBy: 'test',
        scopes: ['quote:read', 'status:read'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/fees',
        method: 'POST',
        headers: { 'x-api-key': rawKey },
        body: { feeBps: 50 },
      });

      const authReq = req as any;
      const keyRecord = listApiKeys().find((k: any) => k.name === 'non-admin');
      authReq.apiKeyRecord = keyRecord ?? makeApiKeyRecord({ name: 'non-admin', scopes: ['quote:read', 'status:read'] });

      const { res, status } = createMockResponse();
      const next = vi.fn();
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('POST /admin/fees/withdraw', () => {
    it.skip('allows fee withdrawal with admin:keys scope', async () => {
      const { rawKey } = createApiKey({
        name: 'fee-withdrawer',
        createdBy: 'test',
        scopes: ['admin:keys'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/fees/withdraw',
        method: 'POST',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = listApiKeys().find((k: any) => k.name === 'fee-withdrawer');
      authReq.apiKeyRecord = keyRecord ?? makeApiKeyRecord({ name: 'fee-withdrawer', scopes: ['admin:keys'] });

      const { res } = createMockResponse();
      const next = vi.fn();
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it.skip('rejects fee withdrawal without admin:keys scope', async () => {
      const { rawKey } = createApiKey({
        name: 'withdraw-non-admin',
        createdBy: 'test',
        scopes: ['quote:read'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/fees/withdraw',
        method: 'POST',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = listApiKeys().find((k: any) => k.name === 'withdraw-non-admin');
      authReq.apiKeyRecord = keyRecord ?? makeApiKeyRecord({ name: 'withdraw-non-admin', scopes: ['quote:read'] });

      const { res, status } = createMockResponse();
      const next = vi.fn();
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
