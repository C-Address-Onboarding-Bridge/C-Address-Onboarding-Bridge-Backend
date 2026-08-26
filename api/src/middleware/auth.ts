import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

/**
 * Express middleware that enforces API key authentication via the `X-API-Key` header.
 * Skips auth entirely when `API_KEYS` is not configured (useful for local development).
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  throw new Error('Not implemented: apiKeyAuth');
}
