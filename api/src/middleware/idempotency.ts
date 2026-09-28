import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { cacheGet, cacheSet, cacheSetNX, cacheDel } from '../services/cache';
import { config } from '../config';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TTL_SECONDS = 86400; // 24 hours
const LOCK_TTL_SECONDS = 30; // short in-flight lock

interface StoredResponse {
  status: number;
  body: unknown;
  bodyHash: string;
}

function idempotencyKey(apiKeyId: string, key: string): string {
  return `idempotency:${apiKeyId}:${key}`;
}

function lockKey(apiKeyId: string, key: string): string {
  return `idempotency:lock:${apiKeyId}:${key}`;
}

function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

function apiKeyId(req: Request): string {
  const reqWithKey = req as Request & { apiKey?: { id?: string }; apiKeyId?: string };
  return reqWithKey.apiKey?.id ?? reqWithKey.apiKeyId ?? 'anonymous';
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

  const scope = apiKeyId(req);
  const cacheKey = idempotencyKey(scope, key);
  const inFlightKey = lockKey(scope, key);
  const bodyHash = hashBody(req.body);

  cacheGet(cacheKey)
    .then((cached) => {
      if (cached) {
        const parsed = JSON.parse(cached) as StoredResponse;
        if (parsed.bodyHash !== bodyHash) {
          res.status(422).json({ error: 'idempotency_key_body_mismatch' });
          return;
        }
        res.status(parsed.status);
        res.setHeader('Idempotent-Replayed', 'true');
        res.json(parsed.body);
        return;
      }

      // Atomically reserve the key before running the handler so concurrent
      // duplicates cannot both submit.
      return cacheSetNX(inFlightKey, '1', LOCK_TTL_SECONDS).then((reserved) => {
        if (!reserved) {
          res.status(409).json({ error: 'idempotency_key_in_flight' });
          return;
        }

        res.setHeader('Idempotent-Replayed', 'false');
        const originalJson = res.json.bind(res);
        res.json = (body: unknown): Response => {
          const status = res.statusCode;
          // Only cache deterministic 2xx/4xx responses; never cache 5xx or
          // other transient failures so retries can succeed.
          if (status >= 200 && status < 500) {
            const toCache = JSON.stringify({ status, body, bodyHash });
            cacheSet(cacheKey, toCache, TTL_SECONDS).catch(() => {
              // Don't break the response if caching fails.
            });
          }
          cacheDel(inFlightKey).catch(() => {
            // Best-effort lock release.
          });
          return originalJson(body);
        };

        next();
      });
    })
    .catch(() => {
      next();
    });
}
