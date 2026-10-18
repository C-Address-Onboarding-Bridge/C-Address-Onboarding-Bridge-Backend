import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';
import { config } from '../config';

// ---------------------------------------------------------------------------
// IP-based sliding-window rate limiter
// ---------------------------------------------------------------------------

interface WindowEntry {
  count: number;
  resetAt: number;
}

const ipWindows = new Map<string, WindowEntry>();

function getClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function checkWindow(
  store: Map<string, WindowEntry>,
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let entry = store.get(key);

  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    store.set(key, entry);
  }

  entry.count += 1;
  const allowed = entry.count <= limit;
  const remaining = Math.max(0, limit - entry.count);

  return { allowed, remaining, resetAt: entry.resetAt };
}

// Periodically evict expired windows to avoid unbounded memory growth.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of ipWindows) {
    if (entry.resetAt <= now) ipWindows.delete(key);
  }
}, 60_000).unref?.();

// ---------------------------------------------------------------------------
// IP rate limit middleware
// ---------------------------------------------------------------------------

export const IP_RATE_LIMIT = {
  windowMs: 60_000,
  max: 100,
};

export function ipRateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ip = getClientIp(req);
  const { allowed, remaining, resetAt } = checkWindow(
    ipWindows,
    ip,
    IP_RATE_LIMIT.max,
    IP_RATE_LIMIT.windowMs
  );

  res.setHeader('X-RateLimit-Limit', String(IP_RATE_LIMIT.max));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));

  if (!allowed) {
    const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    logger.warn({ ip }, 'IP rate limit exceeded');
    res.status(429).json({ error: 'Too Many Requests', retryAfter });
    return;
  }

  next();
}

// ---------------------------------------------------------------------------
// Rate limit response headers
// ---------------------------------------------------------------------------

export function applyRateLimitHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-RateLimit-Policy', 'sliding-window');
  next();
}

// ---------------------------------------------------------------------------
// Tier-based rate limiting (per API key)
// ---------------------------------------------------------------------------

export const FUND_ENDPOINT_LIMIT = {
  windowMs: 60_000,
  max: 30,
};

const TIER_LIMITS: Record<string, number> = {
  free: 60,
  standard: 120,
  high: 500,
};

const tierWindows = new Map<string, WindowEntry>();

function resolveTier(req: Request): string {
  const record = (req as Request & { apiKeyRecord?: { tier?: string } }).apiKeyRecord;
  return record?.tier ?? 'free';
}

export function tierRateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const tier = resolveTier(req);
  const limit = TIER_LIMITS[tier] ?? TIER_LIMITS.free;
  const key = `${tier}:${getClientIp(req)}`;

  const { allowed, remaining, resetAt } = checkWindow(
    tierWindows,
    key,
    limit,
    FUND_ENDPOINT_LIMIT.windowMs
  );

  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));

  if (!allowed) {
    const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    logger.warn({ tier, ip: getClientIp(req) }, 'Tier rate limit exceeded');
    res.status(429).json({ error: 'Too Many Requests', retryAfter });
    return;
  }

  next();
}

// ---------------------------------------------------------------------------
// Telemetry endpoint rate limiting (IP-keyed)
// ---------------------------------------------------------------------------

export const TELEMETRY_ENDPOINT_LIMIT = 20;

const TELEMETRY_WINDOW_MS = 60_000;
const telemetryWindows = new Map<string, WindowEntry>();

export function telemetryRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = getClientIp(req);
  const { allowed, remaining, resetAt } = checkWindow(
    telemetryWindows,
    ip,
    TELEMETRY_ENDPOINT_LIMIT,
    TELEMETRY_WINDOW_MS
  );

  res.setHeader('X-RateLimit-Limit', String(TELEMETRY_ENDPOINT_LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));

  if (!allowed) {
    const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    logger.warn({ ip }, 'Telemetry rate limit exceeded');
    res.status(429).json({ error: 'Too Many Requests', retryAfter });
    return;
  }

  next();
}
