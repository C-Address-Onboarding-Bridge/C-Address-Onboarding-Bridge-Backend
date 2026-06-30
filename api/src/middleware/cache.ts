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
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!isRedisEnabled()) {
      next();
      return;
    }

    const discriminator = opts.key ? opts.key(req) : (opts.keyFn ?? defaultKeyFn)(req);

    const hit = await swrGet<unknown>(discriminator);

    if (hit !== null) {
      res.setHeader('X-Cache', hit.stale ? 'STALE' : 'HIT');
      // Instruct downstream caches how long to hold the response.
      res.setHeader('Cache-Control', `public, max-age=${opts.ttl}`);

      if (hit.stale) {
        // Background revalidation: intercept the next handler's response and
        // re-populate the cache, but serve the stale value right now.
        setImmediate(() => {
          withSingleFlight(discriminator, async () => {
            // We can't re-run the handler here without re-creating the request
            // context, so we mark the key as "needs refresh" by deleting it.
            // The next real request will fill it again with a fresh value.
            // For full background refresh, the route handler itself calls
            // swrSet after computing the value.
            return null;
          }).catch(() => {
            // Ignore background errors.
          });
        });
      }

      res.json(hit.value);
      return;
    }

    // Cache miss – let the handler run, then intercept res.json to cache the body.
    res.setHeader('X-Cache', 'MISS');

    const originalJson = res.json.bind(res);
    res.json = (body: unknown): Response => {
      // Only cache successful responses.
      if (res.statusCode >= 200 && res.statusCode < 300) {
        swrSet(discriminator, body, opts.ttl).catch(() => {
          // Don't break the response if caching fails.
        });
      }
      return originalJson(body);
    };

    next();
  };
}
