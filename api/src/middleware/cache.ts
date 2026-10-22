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
import { swrGet, swrSet, isRedisEnabled, withSingleFlight } from '../services/cache';

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
  /** Compute a fresh response body without running Express middleware again. */
  revalidate: (req: Request) => Promise<unknown>;
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

interface CachedResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  cachedAt: number;
}

function isCachedResponse(value: unknown): value is CachedResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CachedResponse).status === 'number' &&
    typeof (value as CachedResponse).cachedAt === 'number'
  );
}

export function cacheMiddleware(opts: CacheMiddlewareOptions): RequestHandler {
  const { ttl } = opts;
  const buildKey = opts.key ?? opts.keyFn ?? defaultKeyFn;

  return async function cacheMiddlewareHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // Gracefully fall through when Redis is unavailable.
    if (!isRedisEnabled()) {
      next();
      return;
    }

    let cacheKey: string;
    try {
      cacheKey = buildKey(req);
    } catch (err) {
      next(err);
      return;
    }

    let cached: { value: CachedResponse; stale: boolean } | null;
    try {
      cached = await swrGet(cacheKey);
    } catch {
      // Cache read failure should never break the request.
      next();
      return;
    }

    if (cached) {
      const entry = cached.value;
      const isStale = cached.stale;

      res.setHeader('X-Cache', isStale ? 'STALE' : 'HIT');
      res.setHeader('Cache-Control', `public, max-age=${ttl}`);
      res.setHeader('Age', String(isStale ? ttl : 0));
      if (entry.headers) {
        for (const [name, value] of Object.entries(entry.headers)) {
          res.setHeader(name, value);
        }
      }

      if (isStale) {
        // Serve stale data while triggering background revalidation (SWR).
        res.status(cached.status).json(cached.body);
        void revalidate(req, cacheKey, ttl, opts.revalidate);
        return;
      }

      res.status(cached.status).json(cached.body);
      return;
    }

    // Cache miss: capture the response so it can be stored on success.
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', `public, max-age=${ttl}`);

    const originalJson = res.json.bind(res);
    res.json = function patchedJson(body?: unknown): Response {
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        const payload: CachedResponse = {
          status,
          body,
          cachedAt: Date.now(),
        };
        void swrSet(cacheKey, payload, ttl).catch(() => {
          /* cache write failures are non-fatal */
        });
      }
      return originalJson(body);
    };

    next();
  };
}

/**
 * Recompute stale entries without replaying Express middleware or writing to
 * the response that has already been sent.
 */
async function revalidate(
  req: Request,
  cacheKey: string,
  ttl: number,
  compute: (req: Request) => Promise<unknown>,
): Promise<void> {
  try {
    await withSingleFlight(cacheKey, async () => {
      const body = await compute(req);
      await swrSet(cacheKey, { status: 200, body, cachedAt: Date.now() } satisfies CachedResponse, ttl);
    });
  } catch {
    /* background revalidation failures are non-fatal */
  }
}
