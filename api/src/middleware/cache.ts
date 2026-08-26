/**
 * Express middleware factory for transparent response caching.
 *
 * Usage:
 *   router.get('/', cacheMiddleware({ ttl: 30, namespace: 'quote', keyFn: (req) => `...` }), handler);
 *
 * Features:
 *  - Serves stale data while triggering background revalidation (SWR).
 *  - Sets X-Cache: HIT | MISS | STALE response header.
 *  - Sets Cache-Control and Age headers so downstream proxies/CDNs can cooperate.
 *  - Only caches successful (2xx) responses.
 *  - Gracefully falls through to the route handler if Redis is unavailable.
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { swrGet, swrSet, withSingleFlight, isRedisEnabled } from '../services/cache';

export interface CacheMiddlewareOptions {
  /** Primary TTL in seconds (stale entries live for TTL + SWR_EXTENSION_SECONDS). */
  ttl: number;
  /**
   * Derive the cache discriminator from the incoming request.
   * Defaults to a stable JSON-serialised combination of params + query + body.
   */
  keyFn?: (req: Request) => string;
  /**
   * Full pre-built cache key. When provided, `keyFn` is ignored.
   * Useful when the key is already computed upstream (e.g. in route handlers).
   */
  key?: (req: Request) => string;
}

/**
 * Build a default, deterministic discriminator from request params, query, and body.
 */
function defaultKeyFn(req: Request): string {
  return JSON.stringify({
    p: req.params,
    q: req.query,
    b: req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0
      ? req.body
      : undefined,
  });
}

export function cacheMiddleware(opts: CacheMiddlewareOptions): RequestHandler {
  throw new Error('Not implemented: cacheMiddleware');
}
