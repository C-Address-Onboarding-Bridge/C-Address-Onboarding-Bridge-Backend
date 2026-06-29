import { Request, Response, NextFunction } from 'express';
import { logger } from '../index';

const SQL_PATTERNS = [
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|TRUNCATE|DECLARE|CAST|CONVERT)\b)/i,
  /(--|\/\*|\*\/|;|\bxp_|\bsp_)/i,
  /(\bOR\b|\bAND\b)\s+['"]?\d+['"]?\s*=\s*['"]?\d+['"]?/i,
  /'\s*(OR|AND)\s*'/i,
  /SLEEP\s*\(\d+\)/i,
  /BENCHMARK\s*\(/i,
];

const NOSQL_PATTERNS = [
  /\$where\b/,
  /\$(ne|gt|lt|gte|lte|in|nin|exists|regex|options|elemMatch|size|all|slice)\b/,
  /\$expr\b/,
  /mapReduce/i,
  /\$function\b/,
];

const XSS_PATTERNS = [
  /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
  /javascript\s*:/gi,
  /on\w+\s*=/gi,
  /<iframe[\s\S]*?>/gi,
  /data:\s*text\/html/gi,
];

const SIZE_LIMITS: Record<string, number> = {
  'application/json': 32 * 1024,
  'text/plain': 8 * 1024,
  'application/x-www-form-urlencoded': 16 * 1024,
};

const DEFAULT_LIMIT = 64 * 1024;

function flattenValue(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap((item) => flattenValue(item));
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    // Include keys so NoSQL operators like $where, $ne are detected regardless of value
    return [
      ...Object.keys(obj),
      ...Object.values(obj).flatMap((item) => flattenValue(item)),
    ];
  }
  return [];
}

function detectPatterns(values: string[], patterns: RegExp[]): boolean {
  return values.some((v) => patterns.some((p) => p.test(v)));
}

function hasParameterPollution(query: Record<string, unknown>): boolean {
  return Object.values(query).some((v) => Array.isArray(v));
}

function sanitizeErrorMessage(msg: string): string {
  return msg.replace(/<[^>]*>/g, '').replace(/javascript:/gi, '').replace(/on\w+=/gi, '');
}

export function contentTypeEnforcement(req: Request, res: Response, next: NextFunction): void {
  const methods = ['POST', 'PUT', 'PATCH'];
  if (!methods.includes(req.method)) {
    next();
    return;
  }

  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json') && !ct.includes('text/')) {
    logger.warn({ ip: req.ip, path: req.path, contentType: ct }, 'rejected non-JSON content-type on mutation endpoint');
    res.status(415).json({ error: 'unsupported_media_type', message: 'Content-Type must be application/json' });
    return;
  }

  next();
}

export function requestSizeLimiting(req: Request, res: Response, next: NextFunction): void {
  const ct = req.headers['content-type'] || '';
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  const key = Object.keys(SIZE_LIMITS).find((k) => ct.includes(k));
  const limit = key ? SIZE_LIMITS[key] : DEFAULT_LIMIT;

  if (contentLength > limit) {
    logger.warn({ ip: req.ip, path: req.path, contentLength, limit }, 'request body too large');
    res.status(413).json({ error: 'payload_too_large', message: `request body exceeds ${limit} bytes` });
    return;
  }

  next();
}

export function injectionProtection(req: Request, res: Response, next: NextFunction): void {
  const candidates = [
    ...flattenValue(req.body),
    ...flattenValue(req.query),
    ...flattenValue(req.params),
  ];

  if (detectPatterns(candidates, SQL_PATTERNS)) {
    logger.warn({ ip: req.ip, path: req.path }, 'SQL injection pattern detected');
    res.status(400).json({ error: 'invalid_input', message: 'request contains disallowed patterns' });
    return;
  }

  if (detectPatterns(candidates, NOSQL_PATTERNS)) {
    logger.warn({ ip: req.ip, path: req.path }, 'NoSQL injection pattern detected');
    res.status(400).json({ error: 'invalid_input', message: 'request contains disallowed patterns' });
    return;
  }

  if (detectPatterns(candidates, XSS_PATTERNS)) {
    logger.warn({ ip: req.ip, path: req.path }, 'XSS pattern detected');
    res.status(400).json({ error: 'invalid_input', message: 'request contains disallowed patterns' });
    return;
  }

  next();
}

export function parameterPollutionProtection(req: Request, res: Response, next: NextFunction): void {
  if (hasParameterPollution(req.query as Record<string, unknown>)) {
    logger.warn({ ip: req.ip, path: req.path }, 'parameter pollution detected');
    res.status(400).json({ error: 'invalid_input', message: 'duplicate query parameters are not allowed' });
    return;
  }

  next();
}

const suspiciousIpCounts = new Map<string, { count: number; windowStart: number }>();
const SUSPICIOUS_WINDOW_MS = 60_000;
const SUSPICIOUS_THRESHOLD = 10;

export function suspiciousRateLimiting(req: Request, res: Response, next: NextFunction): void {
  next();
}

export function flagSuspiciousRequest(ip: string): boolean {
  const now = Date.now();
  const entry = suspiciousIpCounts.get(ip);

  if (!entry || now - entry.windowStart > SUSPICIOUS_WINDOW_MS) {
    suspiciousIpCounts.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  if (entry.count > SUSPICIOUS_THRESHOLD) {
    logger.warn({ ip, count: entry.count }, 'IP exceeded suspicious request threshold');
    return true;
  }

  return false;
}

export function xssErrorSanitizer(_err: Error, _req: Request, res: Response, next: NextFunction): void {
  next(_err);
}

export { sanitizeErrorMessage };

export function securityMiddleware(req: Request, res: Response, next: NextFunction): void {
  requestSizeLimiting(req, res, () => {
    parameterPollutionProtection(req, res, () => {
      injectionProtection(req, res, next);
    });
  });
}
