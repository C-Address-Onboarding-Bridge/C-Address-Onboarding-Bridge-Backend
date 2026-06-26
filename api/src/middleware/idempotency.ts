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
  const key = req.headers['x-idempotency-key'] as string | undefined;

  if (!key) {
    if ((config as { idempotency?: { required?: boolean } }).idempotency?.required) {
      res.status(400).json({
        error: 'missing_idempotency_key',
        message: 'X-Idempotency-Key header is required',
      });
      return;
    }
    next();
    return;
  }

  if (!UUID_V4_RE.test(key)) {
    res.status(400).json({
      error: 'invalid_idempotency_key',
      message: 'X-Idempotency-Key must be a valid UUID v4',
    });
    return;
  }

  const cKey = idempotencyKey(key);

  cacheGet(cKey).then((stored) => {
    if (stored !== null) {
      const parsed: StoredResponse = JSON.parse(stored);
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(parsed.status).json(parsed.body);
      return;
    }

    const originalJson = res.json.bind(res);
    const originalStatus = res.status.bind(res);
    let statusCode = 200;

    res.status = (code: number) => {
      statusCode = code;
      return originalStatus(code);
    };

    res.json = (body: unknown) => {
      cacheSet(cKey, JSON.stringify({ status: statusCode, body }), TTL_SECONDS).catch(() => {});
      res.setHeader('Idempotent-Replayed', 'false');
      return originalJson(body);
    };

    next();
  }).catch(() => next());
}
