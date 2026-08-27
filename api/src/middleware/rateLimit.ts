import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import NodeCache from 'node-cache';
import { config } from '../config';
import { logger } from '../logger';
import { sendAbuseAlert } from '../services/abuseAlert';
import { RedisRateLimitStore } from './redisRateLimitStore';

const TIER_LIMITS: Record<string, number> = {
  low: 30,
  standard: 100,
  high: 500,
};

export const FUND_ENDPOINT_LIMIT = 10;
export const IP_RATE_LIMIT = 100;
export const TELEMETRY_ENDPOINT_LIMIT = 20; // Stricter limit for telemetry — no auth required

const abuseCache = new NodeCache({ stdTTL: 300 });
const ipBanCache = new NodeCache({ stdTTL: 3600 });
const requestCostCache = new NodeCache({ stdTTL: 3600 });

const MAX_REQUEST_COST_PER_KEY = 1_000_000;
const SUSPICIOUS_PATTERN_THRESHOLD = 5;
const BAN_THRESHOLD = 3;
const LARGE_AMOUNT_THRESHOLD = 10_000_000_000;

interface SuspiciousActivity {
  count: number;
  firstSeen: number;
  patterns: string[];
  addresses: string[];
}

interface RequestCost {
  totalCost: number;
  requestCount: number;
}

function isIPBanned(ip: string): boolean {
  return ipBanCache.has(ip);
}

function banIP(ip: string, pattern: string): void {
  ipBanCache.set(ip, true);
  logger.warn({ ip, pattern }, 'IP banned due to suspicious activity');
  void sendAbuseAlert({ type: 'ip_banned', ip, pattern });
}

function resolveTier(req: Request): 'low' | 'standard' | 'high' {
  const tier = req.apiKeyRecord?.rateLimit;
  if (tier === 'low' || tier === 'standard' || tier === 'high') {
    return tier;
  }
  return 'low';
}

function createLimiter(max: number, keyPrefix: string) {
  const store = config.rateLimit.redisEnabled
    ? new RedisRateLimitStore(keyPrefix)
    : undefined;

  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: Math.max(max + config.rateLimit.burstFactor, max),
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator: (request) => {
      const apiKey = request.headers['x-api-key']?.toString();
      return `${keyPrefix}${apiKey || request.ip || 'anonymous'}`;
    },
    message: { error: 'rate_limit', message: 'too many requests, try again later' },
    handler: (_request, response) => {
      response.set('Retry-After', String(Math.ceil(config.rateLimit.windowMs / 1000)));
      response.status(429).json({ error: 'rate_limit', message: 'too many requests, try again later' });
    },
  });
}

const ipLimiter = createLimiter(IP_RATE_LIMIT, 'ip_');
const fundLimiter = createLimiter(FUND_ENDPOINT_LIMIT, 'fund_');
const telemetryLimiter = createLimiter(TELEMETRY_ENDPOINT_LIMIT, 'telemetry_');
const tierLimiters = {
  low: createLimiter(TIER_LIMITS.low, 'tier_low_'),
  standard: createLimiter(TIER_LIMITS.standard, 'tier_std_'),
  high: createLimiter(TIER_LIMITS.high, 'tier_high_'),
};

/** Global IP rate limit — applied to all requests before body parsing. Excludes webhooks. */
export const ipRateLimitMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Skip IP rate limiting for webhook endpoints — they are server-to-server and already
  // authenticated via HMAC signature verification. Excluding them prevents high webhook
  // volume from one provider from throttling customer API traffic, and vice versa.
  if (req.path && req.path.startsWith('/webhook/')) {
    return next();
  }

  const ip = req.ip ?? 'unknown';
  if (isIPBanned(ip)) {
    res.status(403).json({ error: 'forbidden', message: 'IP temporarily banned due to suspicious activity' });
    return;
  }
  ipLimiter(req, res, next);
};

/** Per-API-key tier rate limit — applied after RBAC on protected routes. */
export function tierRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const tier = resolveTier(req);
  tierLimiters[tier](req, res, next);
}

/** Fund endpoint rate limit — 10 req/min per API key or IP. */
export const fundEndpointRateLimit = fundLimiter;

/** Telemetry endpoint rate limit — 20 req/min per IP (stricter, no auth required). */
export const telemetryRateLimit = telemetryLimiter;

export function applyRateLimitHeaders(_req: Request, res: Response, next: NextFunction) {
  throw new Error('Not implemented: applyRateLimitHeaders');
}

export function trackRequestCost(apiKey: string, cost: number): boolean {
  throw new Error('Not implemented: trackRequestCost');
}

/**
 * Abuse detection middleware — must run after express.json() so req.body is populated.
 */
export function fundAbuseDetectionMiddleware(req: Request, res: Response, next: NextFunction) {
  throw new Error('Not implemented: fundAbuseDetectionMiddleware');
}

/** @deprecated Use ipRateLimitMiddleware + fundEndpointRateLimit */
export const rateLimitMiddleware = ipRateLimitMiddleware;
