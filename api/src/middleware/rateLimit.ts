import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config';

const DEFAULT_TIER = 'standard';

const TIER_LIMITS: Record<string, number> = {
  low: 30,
  standard: 100,
  high: 500,
};

const createLimiter = (max: number) =>
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: Math.max(max + config.rateLimit.burstFactor, max),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (request) => request.headers['x-api-key']?.toString() || request.ip || 'anonymous',
    message: { error: 'rate_limit', message: 'too many requests, try again later' },
    handler: (_request, response) => {
      response.set('Retry-After', String(Math.ceil(config.rateLimit.windowMs / 1000)));
      response.status(429).json({ error: 'rate_limit', message: 'too many requests, try again later' });
    },
  });

const RATE_LIMITERS: Record<string, ReturnType<typeof createLimiter>> = {
  low: createLimiter(TIER_LIMITS.low),
  standard: createLimiter(TIER_LIMITS.standard),
  high: createLimiter(TIER_LIMITS.high),
};

function getTierForPath(path: string): keyof typeof TIER_LIMITS {
  if (path.includes('/quote')) return 'low';
  if (path.includes('/fund') || path.includes('/offramp') || path.includes('/cex')) return 'standard';
  return 'standard';
}

export function applyRateLimitHeaders(req: Request, res: Response, next: NextFunction) {
  const tier = getTierForPath(req.path);
  res.set('X-RateLimit-Limit', String(TIER_LIMITS[tier]));
  res.set('X-RateLimit-Policy', tier);
  res.set('X-RateLimit-Remaining', String(TIER_LIMITS[tier]));
  next();
}

export const rateLimitMiddleware = (req: Request, res: Response, next: NextFunction) => {
  if (config.rateLimit.redisEnabled) {
    return next();
  }
  const tier = getTierForPath(req.path);
  return RATE_LIMITERS[tier](req, res, next);
};
