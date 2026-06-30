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
  const tier = req.apiKeyRecord?.rateLimit ?? req.headers['x-rate-limit-tier'];
  if (tier === 'low' || tier === 'standard' || tier === 'high') {
    return tier;
  }
  return 'standard';
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
const tierLimiters = {
  low: createLimiter(TIER_LIMITS.low, 'tier_low_'),
  standard: createLimiter(TIER_LIMITS.standard, 'tier_std_'),
  high: createLimiter(TIER_LIMITS.high, 'tier_high_'),
};

/** Global IP rate limit — applied to all requests before body parsing. */
export const ipRateLimitMiddleware = (req: Request, res: Response, next: NextFunction) => {
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

export function applyRateLimitHeaders(_req: Request, res: Response, next: NextFunction) {
  res.on('finish', () => {
    if (!res.getHeader('X-RateLimit-Limit') && !res.getHeader('RateLimit-Limit')) {
      res.set('X-RateLimit-Policy', 'standard');
    }
  });
  next();
}

export function trackRequestCost(apiKey: string, cost: number): boolean {
  const key = `cost_${apiKey}`;
  const current = requestCostCache.get<RequestCost>(key) || { totalCost: 0, requestCount: 0 };

  current.totalCost += cost;
  current.requestCount++;
  requestCostCache.set(key, current);

  if (current.totalCost > MAX_REQUEST_COST_PER_KEY) {
    logger.warn({ apiKey, totalCost: current.totalCost }, 'API key exceeded cost limit');
    void sendAbuseAlert({
      type: 'cost_limit_exceeded',
      ip: 'unknown',
      apiKeyId: apiKey,
      details: { totalCost: current.totalCost },
    });
    return false;
  }
  return true;
}

/**
 * Abuse detection middleware — must run after express.json() so req.body is populated.
 */
export function fundAbuseDetectionMiddleware(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip ?? 'unknown';
  const apiKeyId = req.apiKeyRecord?.id ?? (req.headers['x-api-key'] as string) ?? 'anonymous';
  const key = `${ip}_${apiKeyId}`;

  if (isIPBanned(ip)) {
    res.status(403).json({ error: 'forbidden', message: 'IP temporarily banned due to suspicious activity' });
    return;
  }

  const activity = abuseCache.get<SuspiciousActivity>(key) || {
    count: 0,
    firstSeen: Date.now(),
    patterns: [],
    addresses: [],
  };

  activity.count++;
  let detectedPattern: string | null = null;
  const body = req.body as Record<string, unknown> | undefined;

  if (body?.amount && parseInt(String(body.amount), 10) > LARGE_AMOUNT_THRESHOLD) {
    detectedPattern = 'large_amount';
  }

  const targetAddress = body?.targetAddress as string | undefined;
  if (targetAddress) {
    if (!activity.addresses.includes(targetAddress)) {
      activity.addresses.push(targetAddress);
    }
    if (activity.addresses.length > 10) {
      detectedPattern = 'multiple_addresses';
    }
  }

  const timeSinceFirst = Date.now() - activity.firstSeen;
  if (timeSinceFirst < 60_000 && activity.count > 20) {
    detectedPattern = 'rapid_requests';
  }

  if (detectedPattern) {
    activity.patterns.push(detectedPattern);
    abuseCache.set(key, activity);

    if (activity.patterns.filter((p) => p === detectedPattern).length >= SUSPICIOUS_PATTERN_THRESHOLD) {
      const banCount = (ipBanCache.get<number>(`ban_count_${ip}`) || 0) + 1;
      ipBanCache.set(`ban_count_${ip}`, banCount);

      if (banCount >= BAN_THRESHOLD) {
        banIP(ip, detectedPattern);
        res.status(403).json({ error: 'forbidden', message: 'IP temporarily banned due to suspicious activity' });
        return;
      }

      logger.warn({ ip, pattern: detectedPattern, count: activity.count }, 'Suspicious activity detected');
      void sendAbuseAlert({
        type: 'suspicious_activity',
        ip,
        apiKeyId,
        pattern: detectedPattern,
        details: { count: activity.count },
      });
    }
  } else {
    abuseCache.set(key, activity);
  }

  const rawKey = req.headers['x-api-key'] as string | undefined;
  if (rawKey && !trackRequestCost(rawKey, 100)) {
    res.status(429).json({ error: 'rate_limit', message: 'API key cost limit exceeded' });
    return;
  }

  next();
}

/** @deprecated Use ipRateLimitMiddleware + fundEndpointRateLimit */
export const rateLimitMiddleware = ipRateLimitMiddleware;
