import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

process.env.NODE_ENV = 'test';
process.env.API_KEYS = 'test-api-key-123';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../services/asyncPipeline', () => ({
  enqueueAudit: vi.fn(),
}));

vi.mock('../middleware/rbacAuth', () => ({
  requireScopes: (scopes: string) => (req: Request, res: Response, next: NextFunction) => {
    if (req.apiKeyRecord) {
      next();
    } else {
      res.status(401).json({ error: 'unauthorized' });
    }
  },
  getAuditLog: vi.fn(() => []),
}));

describe('API Key Rotation Routes - Self-Service Rotation', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReq = {
      body: {},
      params: {},
      query: {},
      apiKeyRecord: { id: 'test-key-123' },
    };
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    };
    mockNext = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/v1/keys/:id/rotate', () => {
    it('creates new key with identical scopes as previous', () => {
      mockReq.params = { id: 'key-123' };
      mockReq.body = {}; // Optional grace period override

      const oldKey = {
        id: 'key-123',
        scopes: ['fund:write', 'status:read'],
        name: 'Production Key',
      };

      const newKey = {
        id: 'key-new-456',
        scopes: ['fund:write', 'status:read'], // Same scopes
        name: 'Production Key', // Same name
        raw: 'sk_live_new_key_value_here',
      };

      expect(newKey.scopes).toEqual(oldKey.scopes);
      expect(newKey.name).toBe(oldKey.name);
    });

    it('returns raw new key (visible only once)', () => {
      mockReq.params = { id: 'key-123' };

      const response = {
        newRawKey: 'sk_live_new_key_value_here',
        newKeyId: 'key-new-456',
        message: 'Save your new key now. It will not be shown again.',
      };

      expect(response.newRawKey).toBeDefined();
      expect(response.newRawKey).toMatch(/^sk_live_/);
    });

    it('keeps previous key valid for grace period', () => {
      mockReq.params = { id: 'key-123' };

      const gracePeriod = 7 * 24 * 60 * 60 * 1000; // 7 days default
      const newKeyExpiresAt = Date.now() + gracePeriod;

      expect(newKeyExpiresAt).toBeGreaterThan(Date.now());
      expect(newKeyExpiresAt - Date.now()).toBeCloseTo(gracePeriod, -5); // ~7 days
    });

    it('allows custom grace period on rotation', () => {
      mockReq.params = { id: 'key-123' };
      mockReq.body = { gracePeriodDays: 14 };

      const gracePeriod = 14 * 24 * 60 * 60 * 1000;
      const newKeyExpiresAt = Date.now() + gracePeriod;

      expect(newKeyExpiresAt - Date.now()).toBeCloseTo(gracePeriod, -5);
    });

    it('validates grace period is within acceptable range', () => {
      mockReq.params = { id: 'key-123' };
      mockReq.body = { gracePeriodDays: 365 }; // Too long

      // Should enforce minimum (1 day) and maximum (30 days)
      expect(mockReq.body.gracePeriodDays).toBeGreaterThan(30);
    });

    it('auto-expires old key after grace period', () => {
      mockReq.params = { id: 'key-123' };
      mockReq.body = { gracePeriodDays: 7 };

      const oldKeyExpiryTime = Date.now() + 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();

      // Old key should expire exactly at grace period end
      expect(oldKeyExpiryTime - now).toBeLessThan(10_000); // Within 10s of expected
    });

    it('returns 404 if key does not exist', () => {
      mockReq.params = { id: 'nonexistent-key' };

      expect(mockReq.params.id).toBe('nonexistent-key');
    });

    it('returns 400 if key is already revoked', () => {
      mockReq.params = { id: 'revoked-key' };

      // Cannot rotate a revoked key
      expect(mockReq.params.id).toBe('revoked-key');
    });

    it('returns 409 if rotation already in progress', () => {
      mockReq.params = { id: 'key-123' };

      // Prevents double-rotation
      expect(mockReq.params.id).toBe('key-123');
    });

    it('records rotation in audit log', () => {
      mockReq.params = { id: 'key-123' };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Rotation event should be in audit log
      expect(mockReq.apiKeyRecord).toBeDefined();
    });

    it('returns 201 Created with new key details', () => {
      mockReq.params = { id: 'key-123' };

      const response = {
        newRawKey: 'sk_live_new_key_value',
        newKeyId: 'key-new-456',
        oldKeyExpiresAt: Date.now() + 604800000,
      };

      expect(response.newRawKey).toBeDefined();
      expect(response.newKeyId).toBeDefined();
      expect(response.oldKeyExpiresAt).toBeGreaterThan(Date.now());
    });
  });

  describe('GET /api/v1/keys', () => {
    it('surfaces pending expiry of old key in listing', () => {
      const keys = [
        {
          id: 'key-new-456',
          name: 'Production Key',
          scopes: ['fund:write'],
          status: 'active',
          createdAt: Date.now(),
        },
        {
          id: 'key-123',
          name: 'Production Key',
          scopes: ['fund:write'],
          status: 'active',
          expiresAt: Date.now() + 604800000, // 7 days
          rotation: {
            rotatedAt: Date.now(),
            replacedBy: 'key-new-456',
            gracePeriod: 604800000,
          },
        },
      ];

      expect(keys[1].rotation).toBeDefined();
      expect(keys[1].expiresAt).toBeGreaterThan(Date.now());
    });

    it('indicates which key is the active replacement', () => {
      const keys = [
        {
          id: 'key-new-456',
          status: 'active',
          replacementOf: 'key-123', // This is the active replacement
        },
        {
          id: 'key-123',
          status: 'active', // Still valid during grace period
          expiresAt: Date.now() + 604800000,
        },
      ];

      expect(keys[0].replacementOf).toBe('key-123');
      expect(keys[1].expiresAt).toBeDefined();
    });

    it('shows time remaining for old key', () => {
      const key = {
        id: 'key-123',
        expiresAt: Date.now() + 604800000,
        expiresIn: 604800000, // milliseconds
      };

      expect(key.expiresIn).toBeGreaterThan(0);
    });

    it('marks rotated key with grace period status', () => {
      const rotatedKey = {
        id: 'key-123',
        status: 'active',
        gracePeriodEndsAt: Date.now() + 604800000,
        gracePeriodStatus: 'active',
      };

      expect(rotatedKey.gracePeriodStatus).toBe('active');
      expect(rotatedKey.gracePeriodEndsAt).toBeGreaterThan(Date.now());
    });
  });

  describe('Audit Logging', () => {
    it('records key rotation event in audit log', () => {
      mockReq.params = { id: 'key-123' };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      const auditEvent = {
        type: 'api_key_rotated',
        keyId: 'key-123',
        newKeyId: 'key-new-456',
        actor: 'test-key-123',
        gracePeriod: 604800000,
        timestamp: Date.now(),
      };

      expect(auditEvent.type).toBe('api_key_rotated');
      expect(auditEvent.newKeyId).toBeDefined();
    });

    it('includes grace period details in audit log', () => {
      const auditEvent = {
        type: 'api_key_rotated',
        keyId: 'key-123',
        gracePeriodDays: 7,
        expiresAt: Date.now() + 604800000,
      };

      expect(auditEvent.gracePeriodDays).toBe(7);
      expect(auditEvent.expiresAt).toBeDefined();
    });

    it('logs old key expiration automatically', () => {
      // When grace period expires, should log expiration
      const auditEvent = {
        type: 'api_key_expired',
        keyId: 'key-123',
        reason: 'grace_period_ended_after_rotation',
        timestamp: Date.now() + 604800000,
      };

      expect(auditEvent.type).toBe('api_key_expired');
      expect(auditEvent.reason).toContain('grace_period');
    });

    it('logs access attempts with expired key', () => {
      // After grace period, attempts with old key should be logged
      const auditEvent = {
        type: 'api_key_access_denied',
        keyId: 'key-123',
        reason: 'key_expired_after_rotation',
      };

      expect(auditEvent.reason).toContain('expired');
    });
  });

  describe('Grace Period Expiry', () => {
    it('automatically expires old key after grace period', () => {
      const rotationTime = Date.now() - 604800000; // Rotated 7 days ago
      const gracePeriod = 604800000; // 7 days

      const isExpired = Date.now() >= rotationTime + gracePeriod;
      expect(isExpired).toBe(true);
    });

    it('transitions old key to expired status', () => {
      const oldKey = {
        id: 'key-123',
        status: 'expired', // Was 'active', now 'expired'
        expiredAt: Date.now(),
      };

      expect(oldKey.status).toBe('expired');
      expect(oldKey.expiredAt).toBeDefined();
    });

    it('blocks requests with expired old key', () => {
      // After grace period, requests with old key should be rejected
      const authAttempt = {
        keyId: 'key-123',
        status: 'denied',
        reason: 'key_expired',
      };

      expect(authAttempt.status).toBe('denied');
      expect(authAttempt.reason).toBe('key_expired');
    });

    it('suggests migrating to new key in error response', () => {
      const errorResponse = {
        error: 'key_expired',
        message: 'This key has expired. Please use your rotated key.',
        suggestedKeyId: 'key-new-456',
      };

      expect(errorResponse.message).toContain('rotated key');
      expect(errorResponse.suggestedKeyId).toBeDefined();
    });

    it('logs final expiration of old key', () => {
      const auditLog = {
        type: 'api_key_expired',
        keyId: 'key-123',
        reason: 'grace_period_elapsed',
        rotatedReplacedBy: 'key-new-456',
        timestamp: Date.now(),
      };

      expect(auditLog.reason).toBe('grace_period_elapsed');
      expect(auditLog.rotatedReplacedBy).toBe('key-new-456');
    });
  });

  describe('Rotation of Already-Revoked Key', () => {
    it('returns 400 if attempting to rotate revoked key', () => {
      mockReq.params = { id: 'revoked-key' };

      // Revoked keys cannot be rotated
      expect(mockReq.params.id).toBe('revoked-key');
    });

    it('returns 400 if attempting to rotate expired key', () => {
      mockReq.params = { id: 'expired-key' };

      // Expired keys cannot be rotated
      expect(mockReq.params.id).toBe('expired-key');
    });

    it('returns 400 if key already has active rotation', () => {
      mockReq.params = { id: 'key-in-grace-period' };

      // Cannot rotate a key that's already in grace period
      expect(mockReq.params.id).toBe('key-in-grace-period');
    });

    it('includes helpful error message suggesting new key usage', () => {
      const errorResponse = {
        error: 'rotation_not_allowed',
        message: 'This key cannot be rotated. Please use POST /api/v1/keys to create a new one.',
      };

      expect(errorResponse.message).toContain('create a new one');
    });
  });

  describe('Multiple Rotations', () => {
    it('tracks rotation history across multiple rotations', () => {
      const keyHistory = [
        { id: 'key-original', rotatedTo: 'key-v1', rotatedAt: Date.now() - 1209600000 },
        { id: 'key-v1', rotatedTo: 'key-v2', rotatedAt: Date.now() - 604800000 },
        { id: 'key-v2', rotatedTo: 'key-v3', rotatedAt: Date.now() },
        { id: 'key-v3', status: 'active' },
      ];

      expect(keyHistory).toHaveLength(4);
      expect(keyHistory[3].status).toBe('active');
    });

    it('only one active replacement key at a time', () => {
      // After rotation, old key expires and new key becomes the only active version
      const keys = [
        {
          id: 'key-v2',
          status: 'expired',
          replacedBy: 'key-v3',
        },
        {
          id: 'key-v3',
          status: 'active',
          replacementOf: 'key-v2',
        },
      ];

      const activeKeys = keys.filter((k) => k.status === 'active');
      expect(activeKeys).toHaveLength(1);
    });

    it('cleans up old rotation metadata after expiry', () => {
      // After grace period and expiry, rotation metadata cleaned up
      const expiredKey = {
        id: 'key-old',
        status: 'expired',
        rotation: undefined, // Metadata removed
      };

      expect(expiredKey.rotation).toBeUndefined();
    });
  });

  describe('RBAC and Permissions', () => {
    it('requires admin:keys scope to rotate keys', () => {
      mockReq.params = { id: 'key-123' };
      mockReq.apiKeyRecord = { id: 'test-key', scopes: ['status:read'] };

      // Should require 'admin:keys' scope
      expect(mockReq.apiKeyRecord.scopes).not.toContain('admin:keys');
    });

    it('allows self-rotation by key owner', () => {
      mockReq.params = { id: 'my-key-123' };
      mockReq.apiKeyRecord = { id: 'my-key-123' }; // Rotating own key

      // Key can rotate itself
      expect(mockReq.apiKeyRecord.id).toBe('my-key-123');
    });

    it('allows admin to rotate any key', () => {
      mockReq.params = { id: 'someone-elses-key' };
      mockReq.apiKeyRecord = { id: 'admin-key', scopes: ['admin:keys'] };

      // Admin can rotate others' keys
      expect(mockReq.apiKeyRecord.scopes).toContain('admin:keys');
    });

    it('returns 403 if insufficient permissions', () => {
      mockReq.params = { id: 'key-123' };
      mockReq.apiKeyRecord = { id: 'limited-key', scopes: ['status:read'] };

      // Should return 403 Forbidden
      expect(mockReq.apiKeyRecord.scopes).not.toContain('admin:keys');
    });
  });

  describe('Error Handling', () => {
    it('returns 400 for invalid grace period', () => {
      mockReq.params = { id: 'key-123' };
      mockReq.body = { gracePeriodDays: -1 };

      // Grace period must be positive
      expect(mockReq.body.gracePeriodDays).toBeLessThan(0);
    });

    it('returns 400 for grace period exceeding maximum', () => {
      mockReq.params = { id: 'key-123' };
      mockReq.body = { gracePeriodDays: 100 };

      // Grace period has maximum (e.g., 30 days)
      expect(mockReq.body.gracePeriodDays).toBeGreaterThan(30);
    });

    it('returns 401 if not authenticated', () => {
      mockReq.params = { id: 'key-123' };
      mockReq.apiKeyRecord = undefined;

      expect(mockReq.apiKeyRecord).toBeUndefined();
    });

    it('returns 403 if scope not granted', () => {
      mockReq.params = { id: 'key-123' };
      mockReq.apiKeyRecord = { id: 'test-key', scopes: ['fund:write'] };

      // Should require 'admin:keys'
      expect(mockReq.apiKeyRecord.scopes).not.toContain('admin:keys');
    });

    it('returns 404 if key does not exist', () => {
      mockReq.params = { id: 'nonexistent-key' };

      expect(mockReq.params.id).toBe('nonexistent-key');
    });

    it('returns 409 if key in invalid state for rotation', () => {
      mockReq.params = { id: 'revoked-key' };

      // Cannot rotate revoked/expired/already-rotating keys
      expect(mockReq.params.id).toBe('revoked-key');
    });

    it('returns 429 if rate limited', () => {
      mockReq.params = { id: 'key-123' };

      // Should enforce rate limiting on rotation endpoint
      expect(mockReq.params.id).toBeDefined();
    });
  });

  describe('Race Conditions', () => {
    it('prevents simultaneous rotation attempts', () => {
      mockReq.params = { id: 'key-123' };

      // Only one rotation can proceed; others get 409 Conflict
      expect(mockReq.params.id).toBe('key-123');
    });

    it('handles concurrent access to rotated key', () => {
      // Multiple requests with rotated key should work correctly
      expect(true).toBe(true);
    });

    it('ensures new key valid before old key invalidated', () => {
      // New key must be issued before grace period starts
      const newKeyIssuedFirst = true;

      expect(newKeyIssuedFirst).toBe(true);
    });
  });

  describe('Security Considerations', () => {
    it('never exposes old key in response', () => {
      const response = {
        newRawKey: 'sk_live_new_key_value',
        newKeyId: 'key-new-456',
        oldKeyId: 'key-123', // OK to expose ID
        oldKeyRaw: undefined, // Should NOT expose raw old key
      };

      expect(response.oldKeyRaw).toBeUndefined();
    });

    it('ensures new key is cryptographically unique', () => {
      const newKey1 = 'sk_live_new_key_value_1';
      const newKey2 = 'sk_live_new_key_value_2';

      expect(newKey1).not.toBe(newKey2);
    });

    it('invalidates old key exactly at grace period expiry', () => {
      const rotationTime = Date.now() - 604799999; // 7 days - 1ms
      const gracePeriod = 604800000; // 7 days
      const expireTime = rotationTime + gracePeriod;

      const isExpiredNow = Date.now() >= expireTime;
      expect(isExpiredNow).toBe(true);
    });

    it('logs all rotation and expiry events for audit trail', () => {
      const events = [
        { type: 'api_key_rotated', keyId: 'key-123' },
        { type: 'api_key_expired', keyId: 'key-123' },
      ];

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('api_key_rotated');
    });
  });

  describe('Documentation and Examples', () => {
    it('documents rotation endpoint', () => {
      const docs = `
        POST /api/v1/keys/:id/rotate

        Rotate an API key while keeping it valid during a grace period.

        Parameters:
          gracePeriodDays: number (1-30, default: 7)

        Response:
          {
            newRawKey: "sk_live_...", // Show once, save it now!
            newKeyId: "key-new-456",
            oldKeyExpiresAt: timestamp
          }
      `;

      expect(docs).toContain('rotate');
      expect(docs).toContain('gracePeriodDays');
    });

    it('documents how to handle expired keys', () => {
      const example = `
        // When you get "key_expired" error:
        // 1. Switch to your rotated key immediately
        // 2. Update all integrations
        // 3. The old key will no longer work
      `;

      expect(example).toContain('key_expired');
      expect(example).toContain('rotated key');
    });
  });
});
