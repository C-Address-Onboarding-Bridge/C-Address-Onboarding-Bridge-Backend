import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createApiKey } from '../middleware/rbacAuth';
import { webhookAdminRouter } from '../routes/webhookAdmin';

process.env.NODE_ENV = 'test';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../services/webhookDelivery', () => ({
  webhookDeliveryService: {
    register: vi.fn(() => ({
      id: 'webhook-1',
      url: 'https://example.com/webhook',
      secret: 'secret123456789',
      events: ['*'],
      apiKey: 'test-key',
      createdAt: new Date(),
    })),
    getRegistrationsByApiKey: vi.fn((apiKey) => [
      {
        id: 'webhook-1',
        url: 'https://example.com/webhook',
        secret: 'secret123456789',
        events: ['*'],
        apiKey,
        createdAt: new Date(),
      },
    ]),
    unregister: vi.fn(() => true),
    getDLQ: vi.fn(() => [
      {
        id: 'dlq-1',
        registration: {
          id: 'webhook-1',
          url: 'https://example.com/webhook',
          secret: 'secret',
          apiKey: 'test-key',
        },
        event: 'funding.completed',
        failedAt: new Date(),
        attempts: [{ status: 500, timestamp: new Date() }],
      },
    ]),
    getDLQEntry: vi.fn((id) =>
      id === 'dlq-1'
        ? {
            id: 'dlq-1',
            registration: {
              id: 'webhook-1',
              url: 'https://example.com/webhook',
              secret: 'secret',
              apiKey: 'test-key',
            },
            event: 'funding.completed',
            failedAt: new Date(),
            attempts: [{ status: 500, timestamp: new Date() }],
          }
        : null,
    ),
    deleteDLQEntry: vi.fn(() => true),
  },
}));

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    ip: '127.0.0.1',
    path: '/api/v1/webhooks',
    method: 'GET',
    headers: {},
    query: {},
    body: {},
    params: {},
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

describe('Webhook Admin Router - Scope Enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /webhooks/register', () => {
    it('allows webhook registration with admin:keys scope', () => {
      const { rawKey } = createApiKey({
        name: 'webhook-admin',
        createdBy: 'test',
        scopes: ['admin:keys'],
      });

      const req = createMockRequest({
        path: '/api/v1/webhooks/register',
        method: 'POST',
        headers: { 'x-api-key': rawKey },
        body: {
          url: 'https://example.com/webhook',
          secret: 'secret123456789',
          events: ['*'],
        },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'webhook-admin');
      authReq.apiKeyRecord = keyRecord;

      const { res } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('rejects webhook registration with quote:read scope only', () => {
      const { rawKey } = createApiKey({
        name: 'quote-only',
        createdBy: 'test',
        scopes: ['quote:read'],
      });

      const req = createMockRequest({
        path: '/api/v1/webhooks/register',
        method: 'POST',
        headers: { 'x-api-key': rawKey },
        body: {
          url: 'https://example.com/webhook',
          secret: 'secret123456789',
          events: ['*'],
        },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'quote-only');
      authReq.apiKeyRecord = keyRecord;

      const { res, status } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects webhook registration with fund:write scope only', () => {
      const { rawKey } = createApiKey({
        name: 'fund-write',
        createdBy: 'test',
        scopes: ['fund:write'],
      });

      const req = createMockRequest({
        path: '/api/v1/webhooks/register',
        method: 'POST',
        headers: { 'x-api-key': rawKey },
        body: {
          url: 'https://example.com/webhook',
          secret: 'secret123456789',
        },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'fund-write');
      authReq.apiKeyRecord = keyRecord;

      const { res, status } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(status).toHaveBeenCalledWith(403);
    });
  });

  describe('GET /webhooks/registrations', () => {
    it('allows webhook list read with admin:keys scope', () => {
      const { rawKey } = createApiKey({
        name: 'webhook-reader',
        createdBy: 'test',
        scopes: ['admin:keys'],
      });

      const req = createMockRequest({
        path: '/api/v1/webhooks/registrations',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'webhook-reader');
      authReq.apiKeyRecord = keyRecord;

      const { res } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('rejects webhook list read with status:read scope only', () => {
      const { rawKey } = createApiKey({
        name: 'status-reader',
        createdBy: 'test',
        scopes: ['status:read'],
      });

      const req = createMockRequest({
        path: '/api/v1/webhooks/registrations',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'status-reader');
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

  describe('DELETE /webhooks/registrations/:id', () => {
    it('allows webhook deletion with admin:keys scope', () => {
      const { rawKey } = createApiKey({
        name: 'webhook-deleter',
        createdBy: 'test',
        scopes: ['admin:keys'],
      });

      const req = createMockRequest({
        path: '/api/v1/webhooks/registrations/webhook-1',
        method: 'DELETE',
        headers: { 'x-api-key': rawKey },
        params: { id: 'webhook-1' },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'webhook-deleter');
      authReq.apiKeyRecord = keyRecord;

      const { res } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('rejects webhook deletion with cex:read scope only', () => {
      const { rawKey } = createApiKey({
        name: 'cex-reader',
        createdBy: 'test',
        scopes: ['cex:read'],
      });

      const req = createMockRequest({
        path: '/api/v1/webhooks/registrations/webhook-1',
        method: 'DELETE',
        headers: { 'x-api-key': rawKey },
        params: { id: 'webhook-1' },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'cex-reader');
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

  describe('GET /webhooks/dlq', () => {
    it('allows DLQ list read with admin:keys scope', () => {
      const { rawKey } = createApiKey({
        name: 'dlq-reader',
        createdBy: 'test',
        scopes: ['admin:keys'],
      });

      const req = createMockRequest({
        path: '/api/v1/webhooks/dlq',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'dlq-reader');
      authReq.apiKeyRecord = keyRecord;

      const { res } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('rejects DLQ list read with quote:read scope only', () => {
      const { rawKey } = createApiKey({
        name: 'quote-only-dlq',
        createdBy: 'test',
        scopes: ['quote:read'],
      });

      const req = createMockRequest({
        path: '/api/v1/webhooks/dlq',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'quote-only-dlq');
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

  describe('GET /webhooks/dlq/:id', () => {
    it('allows DLQ entry detail read with admin:keys scope', () => {
      const { rawKey } = createApiKey({
        name: 'dlq-detail-reader',
        createdBy: 'test',
        scopes: ['admin:keys'],
      });

      const req = createMockRequest({
        path: '/api/v1/webhooks/dlq/dlq-1',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
        params: { id: 'dlq-1' },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'dlq-detail-reader');
      authReq.apiKeyRecord = keyRecord;

      const { res } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('rejects DLQ entry detail read with fund:write scope only', () => {
      const { rawKey } = createApiKey({
        name: 'fund-writer-dlq',
        createdBy: 'test',
        scopes: ['fund:write'],
      });

      const req = createMockRequest({
        path: '/api/v1/webhooks/dlq/dlq-1',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
        params: { id: 'dlq-1' },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'fund-writer-dlq');
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

  describe('DELETE /webhooks/dlq/:id', () => {
    it('allows DLQ entry deletion with admin:keys scope', () => {
      const { rawKey } = createApiKey({
        name: 'dlq-deleter',
        createdBy: 'test',
        scopes: ['admin:keys'],
      });

      const req = createMockRequest({
        path: '/api/v1/webhooks/dlq/dlq-1',
        method: 'DELETE',
        headers: { 'x-api-key': rawKey },
        params: { id: 'dlq-1' },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'dlq-deleter');
      authReq.apiKeyRecord = keyRecord;

      const { res } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('rejects DLQ entry deletion with status:read scope only', () => {
      const { rawKey } = createApiKey({
        name: 'status-reader-dlq',
        createdBy: 'test',
        scopes: ['status:read'],
      });

      const req = createMockRequest({
        path: '/api/v1/webhooks/dlq/dlq-1',
        method: 'DELETE',
        headers: { 'x-api-key': rawKey },
        params: { id: 'dlq-1' },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'status-reader-dlq');
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

  describe('Scope enforcement - comprehensive matrix', () => {
    it('admin:keys grants access to all webhook admin endpoints', () => {
      const { rawKey } = createApiKey({
        name: 'webhook-full-admin',
        createdBy: 'test',
        scopes: ['admin:keys'],
      });

      const webhookEndpoints = [
        { path: '/api/v1/webhooks/register', method: 'POST' },
        { path: '/api/v1/webhooks/registrations', method: 'GET' },
        { path: '/api/v1/webhooks/registrations/webhook-1', method: 'DELETE' },
        { path: '/api/v1/webhooks/dlq', method: 'GET' },
        { path: '/api/v1/webhooks/dlq/dlq-1', method: 'GET' },
        { path: '/api/v1/webhooks/dlq/dlq-1', method: 'DELETE' },
      ];

      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'webhook-full-admin');

      webhookEndpoints.forEach((_endpoint) => {
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

    it('non-admin scopes are rejected from all webhook admin endpoints', () => {
      const nonAdminScopes = ['quote:read', 'fund:write', 'status:read', 'cex:read'];
      const webhookEndpoints = ['/webhooks/register', '/webhooks/registrations', '/webhooks/dlq'];

      nonAdminScopes.forEach((scope) => {
        const { rawKey } = createApiKey({
          name: `limited-webhook-${scope}`,
          createdBy: 'test',
          scopes: [scope as any],
        });

        const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === `limited-webhook-${scope}`);

        webhookEndpoints.forEach((_endpoint) => {
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

  describe('DLQ scope isolation', () => {
    it('a key with only quote:read is rejected from /api/v1/webhooks/dlq', () => {
      const { rawKey } = createApiKey({
        name: 'quote-dlq-access',
        createdBy: 'test',
        scopes: ['quote:read'],
      });

      const req = createMockRequest({
        path: '/api/v1/webhooks/dlq',
        method: 'GET',
        headers: { 'x-api-key': rawKey },
      });

      const authReq = req as any;
      const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === 'quote-dlq-access');
      authReq.apiKeyRecord = keyRecord;

      const { res, status } = createMockResponse();
      const next = vi.fn();
      const requireScopes = require('../middleware/rbacAuth').requireScopes;
      const scopeMiddleware = requireScopes('admin:keys');
      scopeMiddleware(req, res, next);

      expect(status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('only admin:keys can access DLQ endpoints', () => {
      const restrictedScopes = [
        ['quote:read'],
        ['fund:write'],
        ['status:read'],
        ['quote:read', 'fund:write'],
        ['status:read', 'cex:read'],
      ];

      const dlqEndpoints = ['/api/v1/webhooks/dlq', '/api/v1/webhooks/dlq/dlq-1'];

      restrictedScopes.forEach((scopes, idx) => {
        const { rawKey } = createApiKey({
          name: `restricted-dlq-${idx}`,
          createdBy: 'test',
          scopes: scopes as any,
        });

        const keyRecord = require('../middleware/rbacAuth').listApiKeys().find((k: any) => k.name === `restricted-dlq-${idx}`);

        dlqEndpoints.forEach((_endpoint) => {
          const req = createMockRequest({ headers: { 'x-api-key': rawKey } });
          const authReq = req as any;
          authReq.apiKeyRecord = keyRecord;

          const { res, status } = createMockResponse();
          const next = vi.fn();
          const requireScopes = require('../middleware/rbacAuth').requireScopes;
          const scopeMiddleware = requireScopes('admin:keys');
          scopeMiddleware(req, res, next);

          expect(status).toHaveBeenCalledWith(403);
        });
      });
    });
  });
});
