import { describe, it, expect, beforeEach } from 'vitest';

// The module is mocked in other test files; here we test the real implementations.
import { validateIpOrCidr, getAuditLog, createApiKey, rbacAuth } from '../rbacAuth';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: '127.0.0.1',
    path: '/api/test',
    method: 'GET',
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const json = () => {};
  const status = () => ({ json });
  return { status, json } as unknown as Response;
}

// ---------------------------------------------------------------------------
// validateIpOrCidr — invalid inputs
// ---------------------------------------------------------------------------

describe('validateIpOrCidr — invalid inputs', () => {
  it('returns false for an IPv4 address with an out-of-range octet (999.1.1.1)', () => {
    expect(validateIpOrCidr('999.1.1.1')).toBe(false);
  });

  it('returns false for a non-numeric IPv4-like string (a.b.c.d)', () => {
    expect(validateIpOrCidr('a.b.c.d')).toBe(false);
  });

  it('returns false for a CIDR with an IPv4 prefix greater than 32 (192.168.1.0/33)', () => {
    expect(validateIpOrCidr('192.168.1.0/33')).toBe(false);
  });

  it('returns false for a CIDR with a negative prefix (-1) (192.168.1.0/-1)', () => {
    expect(validateIpOrCidr('192.168.1.0/-1')).toBe(false);
  });

  it('returns false for a CIDR with a non-integer prefix (192.168.1.0/abc)', () => {
    expect(validateIpOrCidr('192.168.1.0/abc')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(validateIpOrCidr('')).toBe(false);
  });

  it('returns false for a CIDR with a non-integer fractional prefix (192.168.1.0/24.5)', () => {
    // parseInt('24.5', 10) === 24 but String(24) !== '24.5', so it must be rejected.
    expect(validateIpOrCidr('192.168.1.0/24.5')).toBe(false);
  });

  it('returns false for a CIDR with an IPv6 prefix greater than 128 (::1/129)', () => {
    expect(validateIpOrCidr('::1/129')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateIpOrCidr — valid inputs
// ---------------------------------------------------------------------------

describe('validateIpOrCidr — valid inputs', () => {
  it('returns true for a valid IPv4 CIDR (192.168.1.0/24)', () => {
    expect(validateIpOrCidr('192.168.1.0/24')).toBe(true);
  });

  it('returns true for a valid plain IPv4 address (192.168.1.1)', () => {
    expect(validateIpOrCidr('192.168.1.1')).toBe(true);
  });

  it('returns true for the IPv6 loopback address (::1)', () => {
    expect(validateIpOrCidr('::1')).toBe(true);
  });

  it('returns true for a valid IPv6 CIDR (::1/128)', () => {
    expect(validateIpOrCidr('::1/128')).toBe(true);
  });

  it('returns true for prefix /0 (matches all) (0.0.0.0/0)', () => {
    expect(validateIpOrCidr('0.0.0.0/0')).toBe(true);
  });

  it('returns true for prefix /32 (single host) (10.0.0.1/32)', () => {
    expect(validateIpOrCidr('10.0.0.1/32')).toBe(true);
  });

  it('returns true for a /128 IPv6 single-host CIDR (2001:db8::1/128)', () => {
    expect(validateIpOrCidr('2001:db8::1/128')).toBe(true);
  });

  it('returns true for a /0 IPv6 CIDR (::/0)', () => {
    expect(validateIpOrCidr('::/0')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Audit log cap (ring-buffer behaviour)
// ---------------------------------------------------------------------------

describe('getAuditLog — ring-buffer cap at MAX_AUDIT_LOG_ENTRIES', () => {
  // The cap is 10 000. We push MAX+1 entries by using rbacAuth with a real key
  // so the production code path (not a direct push) exercises the cap logic.
  // However, pushing 10 001 rbacAuth calls is slow; instead we push 10 001
  // entries by calling rbacAuth that many times on a valid key.
  //
  // To keep the test fast we rely on the fact that getAuditLog().total reflects
  // the current in-memory log length (bounded by MAX_AUDIT_LOG_ENTRIES).
  // We only need to verify the cap is enforced; we do NOT need to fill the
  // entire 10 000-slot buffer from zero, because other tests have already
  // populated some entries. We just need to observe that total never exceeds
  // MAX_AUDIT_LOG_ENTRIES even when we push beyond it.

  const MAX_AUDIT_LOG_ENTRIES = 10_000;

  it('total never exceeds MAX_AUDIT_LOG_ENTRIES after many log entries', () => {
    // Create a key to use for triggering audit log entries.
    const { rawKey } = createApiKey({
      name: 'audit-cap-test',
      createdBy: 'test',
      scopes: ['quote:read'],
    });

    const req = mockReq({ headers: { 'x-api-key': rawKey } });
    const res = mockRes();
    const next = () => {};

    // Determine how many more entries we need to push to guarantee we exceed
    // the cap (allowing for entries already in the log from other tests).
    const { total: before } = getAuditLog(0, 1);
    const entriesToPush = MAX_AUDIT_LOG_ENTRIES - before + 1; // at least 1 over the cap

    for (let i = 0; i < entriesToPush; i++) {
      rbacAuth(req, res, next);
    }

    const { total: after } = getAuditLog(0, 1);
    expect(after).toBeLessThanOrEqual(MAX_AUDIT_LOG_ENTRIES);
  });
});

// ---------------------------------------------------------------------------
// getAuditLog — pagination
// ---------------------------------------------------------------------------

describe('getAuditLog — pagination', () => {
  // Ensure there are enough entries to paginate by seeding a few.
  beforeEach(() => {
    const { rawKey } = createApiKey({
      name: 'pagination-test-key',
      createdBy: 'test',
      scopes: ['quote:read'],
    });
    const req = mockReq({ headers: { 'x-api-key': rawKey } });
    const res = mockRes();
    const next = () => {};
    // Push 5 entries.
    for (let i = 0; i < 5; i++) {
      rbacAuth(req, res, next);
    }
  });

  it('returns the total count of all log entries', () => {
    const { total } = getAuditLog(0, 10);
    expect(total).toBeGreaterThanOrEqual(5);
  });

  it('returns at most `limit` entries', () => {
    const { entries } = getAuditLog(0, 3);
    expect(entries.length).toBeLessThanOrEqual(3);
  });

  it('returns the correct window when offset is applied', () => {
    const all = getAuditLog(0, 1000);
    const offset = 2;
    const limit = 2;
    const page = getAuditLog(offset, limit);

    expect(page.entries).toHaveLength(Math.min(limit, Math.max(0, all.total - offset)));
    if (all.entries.length > offset) {
      expect(page.entries[0]).toEqual(all.entries[offset]);
    }
  });

  it('echoes back the requested offset and limit in the response', () => {
    const result = getAuditLog(1, 7);
    expect(result.offset).toBe(1);
    expect(result.limit).toBe(7);
  });

  it('returns an empty entries array when offset exceeds total', () => {
    const { total } = getAuditLog(0, 1);
    const { entries } = getAuditLog(total + 999, 10);
    expect(entries).toHaveLength(0);
  });

  it('returns shallow copies — mutating a returned entry does not affect the log', () => {
    const { entries: first } = getAuditLog(0, 1);
    expect(first.length).toBeGreaterThan(0);

    const originalPath = first[0].path;
    (first[0] as Record<string, unknown>).path = '/mutated';

    const { entries: second } = getAuditLog(0, 1);
    expect(second[0].path).toBe(originalPath);
  });
});
