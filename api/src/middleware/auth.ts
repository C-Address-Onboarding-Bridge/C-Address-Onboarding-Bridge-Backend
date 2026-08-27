import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

/**
 * Express middleware that enforces API key authentication via the `X-API-Key` header.
 * Skips auth entirely when `API_KEYS` is not configured (useful for local development).
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.apiKeys || config.apiKeys.length === 0) {
    return next();
  }

  const apiKey = req.get('X-API-Key');
  if (!apiKey || !config.apiKeys.includes(apiKey)) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }

  next();
}
