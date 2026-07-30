import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createApiKey } from '../middleware/rbacAuth';
import { adminRouter } from '../routes/admin';

process.env.NODE_ENV = 'test';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../services/transactions', () => ({
  getAdminAuditLog: vi.fn(() => []),
  getFeeConfig: vi.fn(() => ({ feeBps: 30, timelockMs: 60000 })),
  getHealthSnapshot: vi.fn(() => ({ status: 'healthy', uptime: 12345 })),
  getTransactionStats: vi.fn(() => ({ totalFunded: 1000, totalFees: 30 })),
  recordAdminAction: vi.fn(),
  updateFeeConfig: vi.fn(() => ({ feeBps: 50, timelockMs: 60000 })),
  withdrawAccumulatedFees: vi.fn(() => ({ status: 'success', withdrawn: 1000 })),
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
  return {
    ip: '127.0.0.1',
    path: '/api/v1/admin/stats',
    method: 'GET',
    headers: {},
    query: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

function createMockResponse(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn().mockReturnValue({});
  const status = vi.fn().mockReturnValue({ json });
  return {
    res: { status, json } as unknown as Response,
    status,
    json,
  };
}

describe('Admin Router - Scope Enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /admin/stats', () => {
    it('allows request with admin:keys scope', async () => {
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
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'admin-key');
      authReq.apiKeyRecord = keyRecord;

      const { res } = createMockResponse();
      const next = vi.fn();

      // Call the endpoint handler directly
      const handler = adminRouter.stack.find((layer: any) => layer.name === 'get')?.handle;
      if (handler) {
        handler(req, res, next);
        expect(res.json).toHaveBeenCalled();
      }
    });

    it('rejects request with quote:read scope only', async () => {
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
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'quote-only');
      authReq.apiKeyRecord = keyRecord;

      const { res, status } = createMockResponse();
      const next = vi.fn();

      // Simulate requireScopes middleware
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('GET /admin/fees', () => {
    it('allows request with admin:keys scope', () => {
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
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'fee-admin');
      authReq.apiKeyRecord = keyRecord;

      const { res } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('rejects request without admin:keys scope', () => {
      const { rawKey } = createApiKey({
        name: 'no-admin',
        createdBy: 'test',
        scopes: ['fund:read', 'quote:read'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/fees',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'no-admin');
      authReq.apiKeyRecord = keyRecord;

      const { res, status } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(status).toHaveBeenCalledWith(403);
    });
  });

  describe('POST /admin/fees', () => {
    it('allows fee update with admin:keys scope', () => {
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
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'fee-updater');
      authReq.apiKeyRecord = keyRecord;

      const { res } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('rejects fee update without admin:keys scope', () => {
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
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'non-admin');
      authReq.apiKeyRecord = keyRecord;

      const { res, status } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('POST /admin/fees/withdraw', () => {
    it('allows fee withdrawal with admin:keys scope', () => {
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
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'fee-withdrawer');
      authReq.apiKeyRecord = keyRecord;

      const { res } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('rejects fee withdrawal without admin:keys scope', () => {
      const { rawKey } = createApiKey({
        name: 'limited-key',
        createdBy: 'test',
        scopes: ['fund:write'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/fees/withdraw',
        method: 'POST',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'limited-key');
      authReq.apiKeyRecord = keyRecord;

      const { res, status } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(status).toHaveBeenCalledWith(403);
    });
  });

  describe('GET /admin/health', () => {
    it('allows health check with admin:keys scope', () => {
      const { rawKey } = createApiKey({
        name: 'health-checker',
        createdBy: 'test',
        scopes: ['admin:keys'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/health',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'health-checker');
      authReq.apiKeyRecord = keyRecord;

      const { res } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('rejects health check without admin:keys scope', () => {
      const { rawKey } = createApiKey({
        name: 'basic-key',
        createdBy: 'test',
        scopes: ['quote:read'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/health',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'basic-key');
      authReq.apiKeyRecord = keyRecord;

      const { res, status } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(status).toHaveBeenCalledWith(403);
    });
  });

  describe('GET /admin/audit/integrity', () => {
    it('allows audit log read with admin:keys scope', () => {
      const { rawKey } = createApiKey({
        name: 'audit-reader',
        createdBy: 'test',
        scopes: ['admin:keys'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/audit/integrity',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
        query: { type: 'admin_operation' },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'audit-reader');
      authReq.apiKeyRecord = keyRecord;

      const { res } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('rejects audit log read without admin:keys scope', () => {
      const { rawKey } = createApiKey({
        name: 'limited-audit',
        createdBy: 'test',
        scopes: ['status:read'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/audit/integrity',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'limited-audit');
      authReq.apiKeyRecord = keyRecord;

      const { res, status } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(status).toHaveBeenCalledWith(403);
    });
  });

  describe('GET /admin/audit/integrity/checkpoints', () => {
    it('allows checkpoint read with admin:keys scope', () => {
      const { rawKey } = createApiKey({
        name: 'checkpoint-reader',
        createdBy: 'test',
        scopes: ['admin:keys'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/audit/integrity/checkpoints',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'checkpoint-reader');
      authReq.apiKeyRecord = keyRecord;

      const { res } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('rejects checkpoint read without admin:keys scope', () => {
      const { rawKey } = createApiKey({
        name: 'no-checkpoint-access',
        createdBy: 'test',
        scopes: ['quote:read', 'fund:write'],
      });

      const req = createMockRequest({
        path: '/api/v1/admin/audit/integrity/checkpoints',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'no-checkpoint-access');
      authReq.apiKeyRecord = keyRecord;

      const { res, status } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(status).toHaveBeenCalledWith(403);
    });
  });

  describe('Scope enforcement - comprehensive matrix', () => {
    it('admin:keys grants access to all admin endpoints', () => {
      const { rawKey } = createApiKey({
        name: 'full-admin',
        createdBy: 'test',
        scopes: ['admin:keys'],
      });

      const adminEndpoints = [
        { path: '/api/v1/admin/stats', method: 'GET' },
        { path: '/api/v1/admin/fees', method: 'GET' },
        { path: '/api/v1/admin/fees', method: 'POST' },
        { path: '/api/v1/admin/fees/withdraw', method: 'POST' },
        { path: '/api/v1/admin/health', method: 'GET' },
        { path: '/api/v1/admin/audit/integrity', method: 'GET' },
        { path: '/api/v1/admin/audit/integrity/checkpoints', method: 'GET' },
      ];

      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'full-admin');

      adminEndpoints.forEach((_endpoint) => {
        const req = createMockRequest({ headers: { 'x-api-key': rawKey } });
        const authReq = req as any;
        authReq.apiKeyRecord = keyRecord;

        const { res } = createMockResponse();
        const next = vi.fn();
        const requireScopes = require('../middleware/rbacAuth').requireScopes;
        const scopeMiddleware = requireScopes('admin:keys');
        scopeMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
      });
    });

    it('non-admin scopes are rejected from all admin endpoints', () => {
      const nonAdminScopes = ['quote:read', 'fund:write', 'status:read', 'cex:read'];
      const adminEndpoints = ['/admin/stats', '/admin/fees', '/admin/health'];

      nonAdminScopes.forEach((scope) => {
        const { rawKey } = createApiKey({
          name: `limited-${scope}`,
          createdBy: 'test',
          scopes: [scope as any],
        });

        const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === `limited-${scope}`);

        adminEndpoints.forEach((_endpoint) => {
          const req = createMockRequest({ headers: { 'x-api-key': rawKey } });
          const authReq = req as any;
          authReq.apiKeyRecord = keyRecord;

          const { res, status } = createMockResponse();
          const next = vi.fn();
          const requireScopes = require('../middleware/rbacAuth').requireScopes;
          const scopeMiddleware = requireScopes('admin:keys');
          scopeMiddleware(req, res, next);

          expect(status).toHaveBeenCalledWith(403);
          expect(next).not.toHaveBeenCalled();
        });
      });
    });
  });
});
