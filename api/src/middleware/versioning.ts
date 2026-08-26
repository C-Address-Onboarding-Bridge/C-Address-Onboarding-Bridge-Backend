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

function resolveVersion(req: Request): ApiVersion {
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

export function versionCompatibility(req: Request, res: Response, next: NextFunction) {
  throw new Error('Not implemented: versionCompatibility');
}
