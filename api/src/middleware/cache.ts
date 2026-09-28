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
import { swrGet, swrSet, isRedisEnabled } from '../services/cache';

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

    let entry: unknown;
    try {
      entry = await swrGet(cacheKey);
    } catch {
      // Cache read failure should never break the request.
      next();
      return;
    }

    if (isCachedResponse(entry)) {
      const age = Math.max(0, Math.floor((Date.now() - entry.cachedAt) / 1000));
      const isStale = age >= ttl;

      res.setHeader('X-Cache', isStale ? 'STALE' : 'HIT');
      res.setHeader('Cache-Control', `public, max-age=${ttl}`);
      res.setHeader('Age', String(age));
      if (entry.headers) {
        for (const [name, value] of Object.entries(entry.headers)) {
          res.setHeader(name, value);
        }
      }

      if (isStale) {
        // Serve stale data while triggering background revalidation (SWR).
        res.status(entry.status).json(entry.body);
        void revalidate(req, res, cacheKey, ttl);
        return;
      }

      res.status(entry.status).json(entry.body);
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
 * Background revalidation for stale entries: run the route handler into a
 * throwaway response, then persist the fresh result.
 */
async function revalidate(
  req: Request,
  res: Response,
  cacheKey: string,
  ttl: number,
): Promise<void> {
  try {
    const captured = await captureResponse(req, res);
    if (captured && captured.status >= 200 && captured.status < 300) {
      const payload: CachedResponse = {
        status: captured.status,
        body: captured.body,
        cachedAt: Date.now(),
      };
      await swrSet(cacheKey, payload, ttl);
    }
  } catch {
    /* background revalidation failures are non-fatal */
  }
}

/**
 * Re-run the downstream handler chain against a synthetic response to capture
 * a fresh payload without touching the already-sent response.
 */
function captureResponse(
  req: Request,
  res: Response,
): Promise<{ status: number; body: unknown } | null> {
  return new Promise((resolve) => {
    const synthetic = Object.create(res) as Response;
    let settled = false;

    synthetic.status = function syntheticStatus(code: number): Response {
      res.statusCode = code;
      return synthetic;
    };
    synthetic.json = function syntheticJson(body?: unknown): Response {
      if (!settled) {
        settled = true;
        resolve({ status: res.statusCode, body });
      }
      return synthetic;
    };
    synthetic.send = function syntheticSend(body?: unknown): Response {
      if (!settled) {
        settled = true;
        resolve({ status: res.statusCode, body });
      }
      return synthetic;
    };

    const stack = (req.app && (req.app as unknown as { _router?: { stack: unknown[] } })._router?.stack) || [];
    const handlers = stack
      .map((layer) => (layer as { handle?: RequestHandler }).handle)
      .filter((handle): handle is RequestHandler => typeof handle === 'function');

    let index = 0;
    const runNext: NextFunction = (err?: unknown) => {
      if (settled) return;
      if (err) {
        settled = true;
        resolve(null);
        return;
      }
      const handler = handlers[index++];
      if (!handler) {
        settled = true;
        resolve(null);
        return;
      }
      try {
        handler(req, synthetic, runNext);
      } catch {
        settled = true;
        resolve(null);
      }
    };

    runNext();
  });
}
