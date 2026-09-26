import { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { versionCompatibility, markDeprecated, createUnversionedRedirect } from '../middleware/versioning';

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

  it('does not falsely expose deprecation headers for active v1 requests', () => {
    const req = buildReq({ path: '/api/v1/quote' });
    const { res, headers } = buildRes();

    versionCompatibility(req, res, vi.fn() as NextFunction);

    expect(headers.deprecation).toBeUndefined();
    expect(headers.sunset).toBeUndefined();
    expect(headers.link).toBeUndefined();
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

  it('exposes deprecation headers when markDeprecated middleware is used', () => {
    const middleware = markDeprecated({
      sunset: '2028-12-31',
      link: '<https://docs.example.com/api/v2>; rel="successor-version"',
    });
    const req = buildReq({ path: '/api/v1/legacy' });
    const { res, headers } = buildRes();

    middleware(req, res, vi.fn() as NextFunction);

    expect(headers.deprecation).toBe('true');
    expect(headers.sunset).toBe('2028-12-31');
    expect(headers.link).toContain('rel="successor-version"');
  });

  it('createUnversionedRedirect redirects unversioned paths to v1 canonical URL with 308', () => {
    const redirectMiddleware = createUnversionedRedirect('/api/quote');
    const req = {
      path: '/api/quote',
      url: '/',
      originalUrl: '/api/quote?sourceAsset=XLM&amount=100',
      get: () => undefined,
      query: {},
    } as unknown as Request;
    let redirectStatus: number | undefined;
    let redirectLocation: string | undefined;
    const res = {
      redirect: (status: number, location: string) => {
        redirectStatus = status;
        redirectLocation = location;
      },
    } as unknown as Response;

    redirectMiddleware(req, res);

    expect(redirectStatus).toBe(308);
    expect(redirectLocation).toBe('/api/v1/quote?sourceAsset=XLM&amount=100');
  });

  it('createUnversionedRedirect redirects to v2 when negotiated via header', () => {
    const redirectMiddleware = createUnversionedRedirect('/api/fund');
    const req = {
      path: '/api/fund',
      url: '/prepare',
      originalUrl: '/api/fund/prepare',
      get: (h: string) => (h === 'x-api-version' ? 'v2' : undefined),
      query: {},
    } as unknown as Request;
    let redirectStatus: number | undefined;
    let redirectLocation: string | undefined;
    const res = {
      redirect: (status: number, location: string) => {
        redirectStatus = status;
        redirectLocation = location;
      },
    } as unknown as Response;

    redirectMiddleware(req, res);

    expect(redirectStatus).toBe(308);
    expect(redirectLocation).toBe('/api/v2/fund/prepare');
  });
});
