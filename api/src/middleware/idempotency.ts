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
  throw new Error('Not implemented: idempotencyMiddleware');
}
