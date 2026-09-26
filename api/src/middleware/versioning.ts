import { Request, Response, NextFunction } from 'express';

export type ApiVersion = 'v1' | 'v2';

function normalizeVersion(value: string | undefined): ApiVersion | undefined {
  if (!value) return undefined;
  const version = value.toLowerCase();
  if (version === 'v2') return 'v2';
  if (version === 'v1' || version === '1') return 'v1';
  if (version === '2') return 'v2';
  return undefined;
}

export function resolveVersion(req: Request): ApiVersion {
  const pathVersion = req.path.match(/^\/api\/(v\d+)/)?.[1];
  if (pathVersion) {
    return normalizeVersion(pathVersion) ?? 'v1';
  }

  const acceptHeader = req.get('accept') || '';
  const acceptVersion = acceptHeader.match(/version=(\d+)/i)?.[1];
  const acceptVersionResolved = normalizeVersion(acceptVersion);
  if (acceptVersionResolved) {
    return acceptVersionResolved;
  }

  const headerVersion = req.get('x-api-version');
  const headerResolved = normalizeVersion(headerVersion);
  if (headerResolved) {
    return headerResolved;
  }

  const queryVersion = typeof req.query.version === 'string' ? req.query.version : undefined;
  const queryResolved = normalizeVersion(queryVersion);
  if (queryResolved) {
    return queryResolved;
  }

  return 'v1';
}

export interface DeprecationOptions {
  sunset?: string;
  link?: string;
}

/**
 * Middleware to mark a specific endpoint as deprecated in accordance with RFC 8594.
 * Emits `Deprecation: true`, and optionally `Sunset` and `Link` headers.
 */
export function markDeprecated(options: DeprecationOptions = {}) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.set('Deprecation', 'true');
    if (options.sunset) {
      res.set('Sunset', options.sunset);
    }
    if (options.link) {
      res.set('Link', options.link);
    }
    next();
  };
}

/**
 * Creates an unversioned route redirect handler that routes requests to the resolved
 * canonical version (`v1` by default, or `v2` if negotiated via header/query) using HTTP 308 (RFC 7538).
 */
export function createUnversionedRedirect(_basePath: string) {
  return (req: Request, res: Response) => {
    const version = (req as Request & { apiVersion?: ApiVersion }).apiVersion ?? resolveVersion(req);
    const target = `/api/${version}${req.originalUrl.slice(4)}`;
    res.redirect(308, target);
  };
}

export function versionCompatibility(req: Request, res: Response, next: NextFunction) {
  const version = resolveVersion(req);
  const reqWithVersion = req as Request & { apiVersion?: ApiVersion };
  reqWithVersion.apiVersion = version;

  res.set('X-API-Version', version);
  next();
}
