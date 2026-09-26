import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { sendAbuseAlert } from '../services/abuseAlert';

/**
 * Rate limiting middleware.
 *
 * Two layers:
 *  - IP limiter: runs globally, before authentication. Keyed strictly by IP so
 *    an attacker cannot mint a fresh bucket by sending a random X-API-Key.
 *  - Tier limiter: runs after authentication. Keyed by the validated API key id
 *    (req.apiKeyRecord.id), never by the raw header value.
 */

// IP-based rate limit: 100 requests per minute per IP
const IP_WINDOW_MS = 60_000;
const IP_MAX_REQUESTS = 100;

// Tier limits (requests per minute)
const TIER_LIMITS: Record<string, number> = {
  low: 20,
  standard: 100,
  high: 500,
};

// Cost tracking
const COST_LIMIT = 1_000_000;
const COST_TTL_MS = 3_600_000;

interface CostEntry {
  cost: number;
  expiresAt: number;
}

const costTracker = new Map<string, CostEntry>();

// Banned IPs (populated by abuse detection)
const bannedIps = new Set<string>();

// Abuse detection thresholds
const ABUSE_WINDOW_MS = 60_000;
const ABUSE_MAX_REQUESTS = 50;
const abuseTracker = new Map<string, { count: number; windowStart: number }>();

/**
 * Path prefixes that must never be IP rate-limited.
 *
 * The IP limiter is mounted at the app root, so `req.path` includes the
 * `/api` mount prefix (e.g. `/api/webhook/moonpay`). Matching on the bare
 * `/webhook` prefix therefore never fired and provider callbacks were counted
 * against the global IP limit. Match the full mounted prefix instead.
 */
const WEBHOOK_PATH_PREFIXES = ['/api/webhook/', '/webhook/'];

/**
 * Whether the request targets a provider webhook route that should bypass the
 * global IP limiter.
 */
export function isWebhookPath(path: string | undefined): boolean {
  if (!path) {
    return false;
  }
  return WEBHOOK_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Build a limiter keyed strictly by IP.
 *
 * The X-API-Key header is deliberately ignored here: this limiter runs before
 * authentication, so trusting the header would let a caller bypass the limit
 * by rotating random keys.
 */
function createIpLimiter() {
  return rateLimit({
    windowMs: IP_WINDOW_MS,
    max: IP_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (request: Request) => {
      return `ip:${request.ip || 'anonymous'}`;
    },
    handler: (request: Request, response: Response) => {
      logger.warn('IP rate limit exceeded', { ip: request.ip });
      response.status(429).json({
        error: 'Too many requests',
        message: 'Rate limit exceeded for this IP address',
      });
    },
  });
}

/**
 * Build a limiter keyed by the validated API key id.
 *
 * Must only be used after authentication has populated req.apiKeyRecord.
 */
function createTierLimiter(max: number) {
  return rateLimit({
    windowMs: IP_WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (request: Request) => {
      const keyId = request.apiKeyRecord?.id;
      return `key:${keyId || request.ip || 'anonymous'}`;
    },
    handler: (request: Request, response: Response) => {
      logger.warn('Tier rate limit exceeded', {
        keyId: request.apiKeyRecord?.id,
      });
      response.status(429).json({
        error: 'Too many requests',
        message: 'Rate limit exceeded for this API key',
      });
    },
  });
}

const ipLimiter = createIpLimiter();
const tierLimiters: Record<string, ReturnType<typeof createTierLimiter>> = {
  low: createTierLimiter(TIER_LIMITS.low),
  standard: createTierLimiter(TIER_LIMITS.standard),
  high: createTierLimiter(TIER_LIMITS.high),
};

/**
 * Global IP rate limiting middleware.
 * Runs before authentication; keyed strictly by IP.
 */
export function ipRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Skip webhook endpoints. The limiter is mounted at the app root, so the
  // path carries the `/api` prefix (e.g. `/api/webhook/moonpay`).
  if (isWebhookPath(req.path)) {
    next();
    return;
  }

  // Block banned IPs
  if (req.ip && bannedIps.has(req.ip)) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Your IP has been temporarily blocked due to abuse',
    });
    return;
  }

  ipLimiter(req, res, next);
}

/**
 * Tier-based rate limiting middleware.
 * Runs after authentication; keyed by the validated API key id.
 *
 * This must be mounted after `rbacAuth` so that `req.apiKeyRecord` is
 * populated and the configured tier (e.g. 'high' = 500/window) is honored.
 * If it runs before authentication, `req.apiKeyRecord` is undefined and every
 * key falls back to the 'low' tier.
 */
export function tierRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const tier = req.apiKeyRecord?.rateLimit || 'low';
  const limiter = tierLimiters[tier] || tierLimiters.low;
  limiter(req, res, next);
}

/**
 * Fund endpoint rate limiting middleware.
 */
export function fundEndpointRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const keyId = req.apiKeyRecord?.id;
  if (!keyId) {
    next();
    return;
  }

  const limiter = tierLimiters.high;
  limiter(req, res, next);
}

/**
 * Apply standard rate limit headers to a response.
 */
export function applyRateLimitHeaders(
  res: Response,
  limit: number,
  remaining: number,
  resetMs: number
): void {
  res.set('X-RateLimit-Limit', String(limit));
  res.set('X-RateLimit-Remaining', String(Math.max(0, remaining)));
  res.set('X-RateLimit-Reset', String(Math.ceil(resetMs / 1000)));
}

/**
 * Track request cost for an API key. Returns false when the cost limit is
 * exceeded (and fires an abuse alert).
 */
export function trackRequestCost(apiKeyId: string, cost: number): boolean {
  const now = Date.now();
  const entry = costTracker.get(apiKeyId);

  if (!entry || entry.expiresAt <= now) {
    costTracker.set(apiKeyId, { cost, expiresAt: now + COST_TTL_MS });
    return cost <= COST_LIMIT;
  }

  entry.cost += cost;

  if (entry.cost > COST_LIMIT) {
    sendAbuseAlert({
      type: 'cost_limit_exceeded',
      apiKeyId,
      cost: entry.cost,
    });
    return false;
  }

  return true;
}

/**
 * Abuse detection middleware for fund endpoints.
 * Tracks request frequency per IP and bans IPs that exceed the threshold.
 */
export function fundAbuseDetectionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const ip = req.ip;
  if (!ip) {
    next();
    return;
  }

  const now = Date.now();
  const entry = abuseTracker.get(ip);

  if (!entry || now - entry.windowStart > ABUSE_WINDOW_MS) {
    abuseTracker.set(ip, { count: 1, windowStart: now });
    next();
    return;
  }

  entry.count += 1;

  if (entry.count > ABUSE_MAX_REQUESTS) {
    bannedIps.add(ip);
    sendAbuseAlert({
      type: 'ip_banned',
      ip,
      count: entry.count,
    });
    res.status(403).json({
      error: 'Forbidden',
      message: 'Your IP has been temporarily blocked due to abuse',
    });
    return;
  }

  next();
}

export const IP_RATE_LIMIT = IP_MAX_REQUESTS;
export const FUND_ENDPOINT_LIMIT = TIER_LIMITS.high;
