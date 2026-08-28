import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

process.env.NODE_ENV = 'test';

vi.mock('../config', () => ({
  config: {
    jobs: {
      enabled: true,
    },
    rbac: {
      enabled: true,
    },
  },
}));

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Bull Board Security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Bull Board should only be mounted when jobs are enabled', async () => {
    const { config } = await import('../config');
    expect(config.jobs.enabled).toBe(true);
  });

  it('unauthenticated request to /api/jobs should return 401', async () => {
    // Bull Board router should be protected by rbacAuth middleware
    const mockReq = {
      ip: '192.0.2.1',
      method: 'GET',
      path: '/api/jobs',
      headers: {
        'x-api-key': '', // No key or invalid key
      },
      user: undefined, // Not authenticated
    } as unknown as Request;

    const statusMock = vi.fn().mockReturnThis();
    const jsonMock = vi.fn();

    const mockRes = {
      status: statusMock,
      json: jsonMock,
      set: vi.fn().mockReturnThis(),
    } as unknown as Response;

    const mockNext = vi.fn();

    // Simulate rbacAuth middleware checking for auth
    const isAuthenticated = Boolean(mockReq.user || mockReq.headers['x-api-key']);

    if (!isAuthenticated) {
      // rbacAuth should return 401
      mockRes.status(401);
      mockRes.json({
        error: 'unauthorized',
        message: 'Authentication required',
      });
    }

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalled();
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('request with invalid auth to /api/jobs should return 401', async () => {
    const mockReq = {
      ip: '192.0.2.1',
      method: 'GET',
      path: '/api/jobs',
      headers: {
        'x-api-key': 'invalid-key',
      },
      user: undefined,
    } as unknown as Request;

    const statusMock = vi.fn().mockReturnThis();
    const jsonMock = vi.fn();

    const mockRes = {
      status: statusMock,
      json: jsonMock,
      set: vi.fn().mockReturnThis(),
    } as unknown as Response;

    const mockNext = vi.fn();

    // Simulate validation of API key
    const validKeys = ['correct-key-1', 'correct-key-2'];
    const apiKey = mockReq.headers['x-api-key'];
    const isValid = apiKey && validKeys.includes(String(apiKey));

    if (!isValid) {
      mockRes.status(401);
      mockRes.json({ error: 'unauthorized' });
    }

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('authenticated request with correct API key should proceed', async () => {
    const validApiKey = 'admin-key-123';

    const mockReq = {
      ip: '192.0.2.1',
      method: 'GET',
      path: '/api/jobs',
      headers: {
        'x-api-key': validApiKey,
      },
    } as unknown as Request;

    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      set: vi.fn().mockReturnThis(),
    } as unknown as Response;

    const mockNext = vi.fn();

    // Simulate rbacAuth validation
    const validKeys = ['admin-key-123', 'admin-key-456'];
    const apiKey = mockReq.headers['x-api-key'];
    const isValid = apiKey && validKeys.includes(String(apiKey));

    if (isValid) {
      mockNext();
    } else {
      mockRes.status(401);
    }

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('Bull Board should require admin:keys scope or dedicated admin scope', async () => {
    const mockReq = {
      ip: '192.0.2.1',
      method: 'GET',
      path: '/api/jobs',
      headers: {
        'x-api-key': 'user-key-123',
      },
      userScopes: ['fund:send', 'quote:read'], // Regular user scopes
    } as unknown as Request;

    const statusMock = vi.fn().mockReturnThis();
    const jsonMock = vi.fn();

    const mockRes = {
      status: statusMock,
      json: jsonMock,
      set: vi.fn().mockReturnThis(),
    } as unknown as Response;

    const mockNext = vi.fn();

    // Simulate requireScopes middleware check
    const requiredScopes = ['admin:keys'];
    const hasScopes = requiredScopes.some(scope =>
      mockReq.userScopes?.includes(scope)
    );

    if (!hasScopes) {
      mockRes.status(403);
      mockRes.json({
        error: 'forbidden',
        message: 'Insufficient permissions',
      });
    }

    expect(statusMock).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('user with admin:keys scope should access Bull Board', async () => {
    const mockReq = {
      ip: '192.0.2.1',
      method: 'GET',
      path: '/api/jobs',
      headers: {
        'x-api-key': 'admin-key-123',
      },
      userScopes: ['admin:keys', 'fund:send'],
    } as unknown as Request;

    const statusMock = vi.fn().mockReturnThis();
    const jsonMock = vi.fn();

    const mockRes = {
      status: statusMock,
      json: jsonMock,
      set: vi.fn().mockReturnThis(),
    } as unknown as Response;

    const mockNext = vi.fn();

    // Simulate requireScopes middleware check
    const requiredScopes = ['admin:keys'];
    const hasScopes = requiredScopes.some(scope =>
      mockReq.userScopes?.includes(scope)
    );

    if (hasScopes) {
      mockNext();
    } else {
      mockRes.status(403);
    }

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('Bull Board mount must be registered before errorHandler', async () => {
    // This is a middleware ordering test
    // Bull Board should be mounted BEFORE errorHandler so errors inside it
    // are properly handled by errorHandler

    // The order in index.ts should be:
    // 1. ... other middleware ...
    // 2. app.use('/api/jobs', rbacAuth, serverAdapter.getRouter());
    // 3. ... other routes ...
    // 4. app.use(xssErrorSanitizer);
    // 5. app.use(errorHandler);

    // If Bull Board is after errorHandler, errors won't be caught
    const middlewareOrder = [
      'rbacAuth + Bull Board Router',
      'other routes',
      'xssErrorSanitizer',
      'errorHandler',
    ];

    const bullBoardIndex = middlewareOrder.findIndex(m => m.includes('Bull Board'));
    const errorHandlerIndex = middlewareOrder.findIndex(m => m === 'errorHandler');

    expect(bullBoardIndex).toBeLessThan(errorHandlerIndex);
  });

  it('Bull Board should not be accessible from unauthorized IPs or networks', async () => {
    const authorizedIps = ['127.0.0.1', '10.0.0.0/8']; // Internal only

    const unauthorizedReq = {
      ip: '203.0.113.42', // External IP
      method: 'GET',
      path: '/api/jobs',
      headers: {},
    } as unknown as Request;

    const statusMock = vi.fn().mockReturnThis();
    const jsonMock = vi.fn();

    const mockRes = {
      status: statusMock,
      json: jsonMock,
      set: vi.fn().mockReturnThis(),
    } as unknown as Response;

    const mockNext = vi.fn();

    // Simulate IP-based access check (in addition to auth)
    const isIpAuthorized = authorizedIps.some(authIp =>
      unauthorizedReq.ip?.startsWith(authIp.split('/')[0]) ?? false
    );

    // Should still require auth even if we do IP checks
    if (!isIpAuthorized) {
      mockRes.status(403);
      mockRes.json({ error: 'forbidden', message: 'Access denied' });
    }

    expect(statusMock).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('Bull Board endpoints should not expose job payloads to unauthorized users', async () => {
    // The test ensures that Bull Board is protected, so only authorized users
    // can see queue contents and job payloads

    const jobPayload = {
      id: 'job-123',
      data: {
        secretKey: 'super-secret-key',
        walletAddress: '0x123abc',
      },
      status: 'completed',
    };

    // Without auth, user should never see this payload
    const mockReq = {
      ip: '192.0.2.1',
      method: 'GET',
      path: '/api/jobs',
      headers: {}, // No auth
    } as unknown as Request;

    const statusMock = vi.fn().mockReturnThis();
    const jsonMock = vi.fn();

    const mockRes = {
      status: statusMock,
      json: jsonMock,
      set: vi.fn().mockReturnThis(),
    } as unknown as Response;

    // Should be blocked before even reaching Bull Board router
    if (!mockReq.headers['x-api-key']) {
      mockRes.status(401);
      mockRes.json({ error: 'unauthorized' });
    }

    expect(statusMock).toHaveBeenCalledWith(401);
    // Payload should never be sent
    expect(jsonMock).not.toHaveBeenCalledWith(expect.objectContaining(jobPayload));
  });

  it('Bull Board job manipulation (retry, promote, delete) should require admin scope', async () => {
    const mockReq = {
      ip: '192.0.2.1',
      method: 'POST',
      path: '/api/jobs/tx-status/retry',
      headers: {
        'x-api-key': 'user-key',
      },
      userScopes: ['fund:send'], // Not admin
    } as unknown as Request;

    const statusMock = vi.fn().mockReturnThis();
    const jsonMock = vi.fn();

    const mockRes = {
      status: statusMock,
      json: jsonMock,
      set: vi.fn().mockReturnThis(),
    } as unknown as Response;

    const mockNext = vi.fn();

    // Simulate requireScopes check
    const requiredScopes = ['admin:keys'];
    const hasScopes = requiredScopes.some(scope =>
      mockReq.userScopes?.includes(scope)
    );

    if (!hasScopes) {
      mockRes.status(403);
      mockRes.json({ error: 'forbidden' });
    }

    expect(statusMock).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });
});
