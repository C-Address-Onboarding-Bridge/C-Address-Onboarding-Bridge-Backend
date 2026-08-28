import { Request, Response, NextFunction } from 'express';
import { cacheGet, cacheSet } from '../services/cache';
import { config } from '../config';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TTL_SECONDS = 86400; // 24 hours

interface StoredResponse {
  status: number;
  body: unknown;
}

function idempotencyKey(key: string): string {
  return `idempotency:${key}`;
}

export function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-idempotency-key'] as string;

  if (!key) {
    if (!config.idempotency.required) {
      next();
      return;
    }
    res.status(400).json({ error: 'missing_idempotency_key' });
    return;
  }

  if (!UUID_V4_RE.test(key)) {
    res.status(400).json({ error: 'invalid_idempotency_key' });
    return;
  }

  const cacheKey = idempotencyKey(key);

  cacheGet(cacheKey)
    .then((cached) => {
      if (cached) {
        const parsed = JSON.parse(cached) as StoredResponse;
        res.status(parsed.status);
        res.setHeader('Idempotent-Replayed', 'true');
        res.json(parsed.body);
        return;
      }

      res.setHeader('Idempotent-Replayed', 'false');
      const originalJson = res.json.bind(res);
      res.json = (body: unknown): Response => {
        const toCache = JSON.stringify({ status: res.statusCode, body });
        cacheSet(cacheKey, toCache, TTL_SECONDS).catch(() => {
          // Don't break the response if caching fails.
        });
        return originalJson(body);
      };

      next();
    })
    .catch(() => {
      next();
    });
}
