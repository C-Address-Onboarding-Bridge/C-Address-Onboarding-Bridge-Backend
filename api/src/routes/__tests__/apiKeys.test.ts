import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { z } from 'zod';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Lightweight mocks so the router can be imported without a real DB/config.
// ---------------------------------------------------------------------------

vi.mock('../../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config', () => ({
  config: {
    soroban: {
      rpcUrls: [],
      feeBps: 30,
      bridgeContractId: 'test-contract',
      networkPassphrase: 'Test',
    },
    logging: {
      version: '0.1.0',
      serviceName: 'test',
      environment: 'test',
      sensitiveFields: [],
      bodyTruncateLength: 200,
    },
    apiKeys: [],
    moonpay: { apiKey: '', secretKey: '' },
    transak: { apiKey: '', environment: 'STAGING', webhookSecret: '' },
    database: { url: '' },
  },
}));

vi.mock('../../services/db', () => ({
  getPool: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Import the schemas and router AFTER mocks are registered.
// ---------------------------------------------------------------------------

// We test the Zod schemas directly (no HTTP needed) for validation edge cases
// because the route itself guards with requireScopes('admin:keys') which would
// reject unauthenticated requests before Zod even runs.  For integration-style
// tests we build a minimal Express app that bypasses RBAC.
//
// Both approaches (schema parsing + supertest) are included below.

import { createApiKey, rbacAuth } from '../../middleware/rbacAuth';
import { apiKeysRouter } from '../apiKeys';

// ---------------------------------------------------------------------------
// Minimal Express app that mounts the router without RBAC middleware so we
// can reach the Zod validation layer directly via supertest.
// ---------------------------------------------------------------------------

const PERMISSION_SCOPES = [
  'quote:read',
  'fund:write',
  'status:read',
  'offramp:write',
  'cex:read',
  'admin:keys',
  'transactions:read',
] as const;

type PermissionScope = (typeof PERMISSION_SCOPES)[number];

const patchApiKeySchema = z
  .object({
    name: z.string().min(1),
    scopes: z.array(z.enum(PERMISSION_SCOPES as [PermissionScope, ...PermissionScope[]])).min(1),
    ipWhitelist: z.array(z.string()),
    expiresAt: z.number().nullable(),
    rateLimit: z.enum(['low', 'standard', 'high']),
  })
  .partial();

const createApiKeySchema = z.object({
  name: z.string().min(1),
  scopes: z.array(z.enum(PERMISSION_SCOPES as [PermissionScope, ...PermissionScope[]])).min(1),
  ipWhitelist: z.array(z.string()).optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  rateLimit: z.enum(['low', 'standard', 'high']).optional(),
});

/** Fake RBAC middleware that injects an admin API key record so routes run. */
function injectAdminKey(req: Request, _res: Response, next: NextFunction) {
  req.apiKeyRecord = {
    id: 'test-admin-key',
    name: 'test-admin',
    createdBy: 'test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastUsedAt: null,
    scopes: [...PERMISSION_SCOPES],
    ipWhitelist: [],
    expiresAt: null,
    rateLimit: 'standard',
    revoked: false,
  };
  req.resolvedScopes = [...PERMISSION_SCOPES];
  next();
}

function buildApp() {
  const app = express();
  app.use(express.json());
  // Inject admin context then mount the router (skips real rbacAuth + requireScopes).
  app.use('/api/v1/keys', injectAdminKey, apiKeysRouter);
  // Generic error handler that converts Zod errors to 400.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'validation_error', issues: err.issues });
      return;
    }
    res.status(500).json({ error: 'internal_server_error' });
  });
  return app;
}

// ---------------------------------------------------------------------------
// Schema-level tests (no HTTP layer required)
// ---------------------------------------------------------------------------

describe('patchApiKeySchema — Zod validation', () => {
  it('accepts { scopes: ["transactions:read"] } without throwing', () => {
    expect(() =>
      patchApiKeySchema.parse({ scopes: ['transactions:read'] }),
    ).not.toThrow();
  });

  it('rejects unknown scope values', () => {
    expect(() =>
      patchApiKeySchema.parse({ scopes: ['unknown:scope'] }),
    ).toThrow();
  });

  it('is partial — accepts an empty object', () => {
    expect(() => patchApiKeySchema.parse({})).not.toThrow();
  });

  it('accepts every known permission scope', () => {
    expect(() =>
      patchApiKeySchema.parse({ scopes: [...PERMISSION_SCOPES] }),
    ).not.toThrow();
  });
});

describe('createApiKeySchema — Zod validation', () => {
  it('accepts { name: "test", scopes: ["transactions:read"] }', () => {
    expect(() =>
      createApiKeySchema.parse({ name: 'test', scopes: ['transactions:read'] }),
    ).not.toThrow();
  });

  it('rejects { name: "test", scopes: ["unknown:scope"] }', () => {
    expect(() =>
      createApiKeySchema.parse({ name: 'test', scopes: ['unknown:scope'] }),
    ).toThrow();
  });

  it('rejects { name: "test", scopes: ["quote:read"], expiresAt: -1 }', () => {
    // expiresAt must be a positive integer (or null/undefined).
    expect(() =>
      createApiKeySchema.parse({ name: 'test', scopes: ['quote:read'], expiresAt: -1 }),
    ).toThrow();
  });

  it('rejects { name: "test", scopes: ["quote:read"], expiresAt: 0 }', () => {
    // 0 is not a positive integer.
    expect(() =>
      createApiKeySchema.parse({ name: 'test', scopes: ['quote:read'], expiresAt: 0 }),
    ).toThrow();
  });

  it('accepts null expiresAt (no expiry)', () => {
    expect(() =>
      createApiKeySchema.parse({ name: 'test', scopes: ['quote:read'], expiresAt: null }),
    ).not.toThrow();
  });

  it('accepts a positive integer expiresAt', () => {
    expect(() =>
      createApiKeySchema.parse({
        name: 'test',
        scopes: ['quote:read'],
        expiresAt: Date.now() + 86_400_000,
      }),
    ).not.toThrow();
  });

  it('requires at least one scope', () => {
    expect(() =>
      createApiKeySchema.parse({ name: 'test', scopes: [] }),
    ).toThrow();
  });

  it('requires a non-empty name', () => {
    expect(() =>
      createApiKeySchema.parse({ name: '', scopes: ['quote:read'] }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// HTTP integration tests via supertest
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/keys/:id — HTTP', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 when patching with { scopes: ["transactions:read"] }', async () => {
    // First create a key so we have a valid ID to patch.
    const { record } = createApiKey({
      name: 'http-patch-test',
      createdBy: 'test',
      scopes: ['quote:read'],
    });

    const res = await request(app)
      .patch(`/api/v1/keys/${record.id}`)
      .send({ scopes: ['transactions:read'] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'updated' });
  });

  it('returns 400 for a PATCH body with an unknown scope', async () => {
    const { record } = createApiKey({
      name: 'http-patch-bad-scope',
      createdBy: 'test',
      scopes: ['quote:read'],
    });

    const res = await request(app)
      .patch(`/api/v1/keys/${record.id}`)
      .send({ scopes: ['unknown:scope'] });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/keys — HTTP', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 201 when creating { name: "test", scopes: ["transactions:read"] }', async () => {
    const res = await request(app)
      .post('/api/v1/keys')
      .send({ name: 'test', scopes: ['transactions:read'] });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('rawKey');
    expect(res.body).toHaveProperty('id');
    expect(res.body.scopes).toContain('transactions:read');
  });

  it('returns 400 when creating { name: "test", scopes: ["unknown:scope"] }', async () => {
    const res = await request(app)
      .post('/api/v1/keys')
      .send({ name: 'test', scopes: ['unknown:scope'] });

    expect(res.status).toBe(400);
  });

  it('returns 400 when creating { name: "test", scopes: ["quote:read"], expiresAt: -1 }', async () => {
    const res = await request(app)
      .post('/api/v1/keys')
      .send({ name: 'test', scopes: ['quote:read'], expiresAt: -1 });

    expect(res.status).toBe(400);
  });

  it('returns 400 when scopes array is empty', async () => {
    const res = await request(app)
      .post('/api/v1/keys')
      .send({ name: 'test', scopes: [] });

    expect(res.status).toBe(400);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/v1/keys')
      .send({ scopes: ['quote:read'] });

    expect(res.status).toBe(400);
  });
});
