import { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { versionCompatibility } from '../middleware/versioning';

function buildReq(overrides: { path?: string; headers?: Record<string, string>; query?: Record<string, string> } = {}): Request {
  const headers = overrides.headers ?? {};
  return {
    path: overrides.path ?? '/api/quote',
    query: overrides.query ?? {},
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function buildRes(): { res: Response; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = {
    set: vi.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
      return res;
    }),
  } as unknown as Response;
  return { res, headers };
}

describe('versionCompatibility', () => {
  it('resolves the version from the request path', () => {
    const req = buildReq({ path: '/api/v2/quote' });
    const { res, headers } = buildRes();
    const next = vi.fn() as NextFunction;

    versionCompatibility(req, res, next);

    expect(headers['x-api-version']).toBe('v2');
    expect(next).toHaveBeenCalled();
  });

  it('resolves the version from the Accept header', () => {
    const req = buildReq({ headers: { accept: 'application/vnd.bridge+json; version=2' } });
    const { res, headers } = buildRes();

    versionCompatibility(req, res, vi.fn() as NextFunction);

    expect(headers['x-api-version']).toBe('v2');
  });

  it('resolves the version from the X-API-Version header', () => {
    const req = buildReq({ headers: { 'x-api-version': 'v2' } });
    const { res, headers } = buildRes();

    versionCompatibility(req, res, vi.fn() as NextFunction);

    expect(headers['x-api-version']).toBe('v2');
  });

  it('resolves the version from the query string', () => {
    const req = buildReq({ query: { version: '2' } });
    const { res, headers } = buildRes();

    versionCompatibility(req, res, vi.fn() as NextFunction);

    expect(headers['x-api-version']).toBe('v2');
  });

  it('prefers the path version over the Accept header', () => {
    const req = buildReq({ path: '/api/v1/quote', headers: { accept: 'application/vnd.bridge+json; version=2' } });
    const { res, headers } = buildRes();

    versionCompatibility(req, res, vi.fn() as NextFunction);

    expect(headers['x-api-version']).toBe('v1');
  });

  it('defaults to v1 when no version is supplied', () => {
    const req = buildReq();
    const { res, headers } = buildRes();

    versionCompatibility(req, res, vi.fn() as NextFunction);

    expect(headers['x-api-version']).toBe('v1');
  });

  it('exposes deprecation headers for v1 requests', () => {
    const req = buildReq({ path: '/api/v1/quote' });
    const { res, headers } = buildRes();

    versionCompatibility(req, res, vi.fn() as NextFunction);

    expect(headers.deprecation).toBe('true');
    expect(headers.sunset).toBe('2027-12-31');
    expect(headers.link).toContain('rel="successor-version"');
  });

  it('does not deprecate v2 requests', () => {
    const req = buildReq({ path: '/api/v2/quote' });
    const { res, headers } = buildRes();

    versionCompatibility(req, res, vi.fn() as NextFunction);

    expect(headers.deprecation).toBeUndefined();
    expect(headers.sunset).toBeUndefined();
  });

  it('attaches the resolved version to the request', () => {
    const req = buildReq({ path: '/api/v2/quote' });
    const { res } = buildRes();

    versionCompatibility(req, res, vi.fn() as NextFunction);

    expect((req as Request & { apiVersion?: string }).apiVersion).toBe('v2');
  });
});
