import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

/**
 * Express middleware that enforces API key authentication via the `X-API-Key` header.
 * Skips auth entirely when `API_KEYS` is not configured (useful for local development).
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  if (config.apiKeys.length === 0) {
    return next();
  }

  const key = req.headers['x-api-key'] as string | undefined;
  if (!key || !config.apiKeys.includes(key)) {
    res.status(401).json({ error: 'unauthorized', message: 'invalid or missing API key' });
    return;
  }

  next();
}
