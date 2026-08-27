import { Request, Response, NextFunction } from 'express';
import { logger } from '../index';

const SQL_PATTERNS = [
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|TRUNCATE|DECLARE|CAST|CONVERT)\b)/i,
  // Detect stored procedure calls and comment markers only in specific contexts
  /\b(xp_|sp_)[\w]+/i,
  // Only match comment patterns when clearly isolated (not in normal text)
  /\/\*[\s\S]*?\*\//,
  /--\s*[\w]/i,
  // SQL statement terminator must be followed by another keyword or be at end
  /;\s*(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|EXEC|UNION|DECLARE)\b/i,
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

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

const ALLOWED_BODY_CONTENT_TYPES = new Set(['application/json']);

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
  // Only methods that carry a body are worth gating. GET/HEAD/DELETE/OPTIONS
  // are allowed through even when a client sends a stray Content-Type.
  if (!BODY_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  const header = req.headers['content-type'];
  const raw = Array.isArray(header) ? header[0] : header;

  // Strip parameters ('application/json; charset=utf-8') and compare only the
  // media type, case-insensitively — RFC 9110 makes both case-insensitive.
  const mediaType = (raw ?? '').split(';')[0].trim().toLowerCase();

  if (!ALLOWED_BODY_CONTENT_TYPES.has(mediaType)) {
    logger.warn(
      { ip: req.ip, path: req.path, method: req.method, contentType: raw },
      'rejected request with unsupported content-type',
    );
    res.status(415).json({
      error: 'unsupported_media_type',
      message: 'Content-Type must be application/json',
    });
    return;
  }

  next();
}

export function requestSizeLimiting(req: Request, res: Response, next: NextFunction): void {
  // Issue #398: Enforce actual size limits, not just header
  const ct = (req.headers['content-type'] ?? '').toLowerCase();
  const limit = SIZE_LIMITS[ct] ?? DEFAULT_LIMIT;

  const contentLengthStr = req.headers['content-length'];
  const contentLength = contentLengthStr ? parseInt(contentLengthStr, 10) : null;

  // If Content-Length is present, check it against the limit
  // Note: express.json() will enforce the actual limit downstream
  if (contentLength !== null && contentLength > limit) {
    res.status(413).json({ error: 'payload_too_large', message: 'Request payload exceeds size limit' });
    return;
  }

  // If Content-Length is missing but the request has a body (POST/PUT),
  // we allow it through and let express.json() enforce the actual limit
  next();
}

const FREE_TEXT_FIELDS = new Set(['memo', 'description', 'notes', 'comment', 'message']);

function isFreetextField(fieldPath: string): boolean {
  const fieldName = fieldPath.split('.').pop()?.toLowerCase() ?? '';
  return FREE_TEXT_FIELDS.has(fieldName);
}

export function injectionProtection(req: Request, res: Response, next: NextFunction): void {
  function checkForInjection(obj: unknown, path = '', isInFreetextField = false): { match: RegExp; field: string } | null {
    if (typeof obj === 'string') {
      // Skip SQL patterns for freetext fields; always check NoSQL and XSS
      if (!isInFreetextField && detectPatterns([obj], SQL_PATTERNS)) {
        return { match: SQL_PATTERNS.find((p) => p.test(obj)) as RegExp, field: path || 'unknown' };
      }
      if (detectPatterns([obj], NOSQL_PATTERNS)) {
        return { match: NOSQL_PATTERNS.find((p) => p.test(obj)) as RegExp, field: path || 'unknown' };
      }
      if (detectPatterns([obj], XSS_PATTERNS)) {
        return { match: XSS_PATTERNS.find((p) => p.test(obj)) as RegExp, field: path || 'unknown' };
      }
      return null;
    }

    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const result = checkForInjection(obj[i], `${path}[${i}]`, isInFreetextField);
        if (result) return result;
      }
      return null;
    }

    if (obj && typeof obj === 'object') {
      const objMap = obj as Record<string, unknown>;
      // Check keys for NoSQL operators like $where, $ne
      if (detectPatterns(Object.keys(objMap), NOSQL_PATTERNS)) {
        const badKey = Object.keys(objMap).find((k) => NOSQL_PATTERNS.some((p) => p.test(k)));
        return { match: NOSQL_PATTERNS.find((p) => p.test(badKey ?? '')) as RegExp, field: path ? `${path}.${badKey}` : badKey ?? 'unknown' };
      }

      for (const [key, value] of Object.entries(objMap)) {
        const fieldPath = path ? `${path}.${key}` : key;
        const isFreetextCheckField = isInFreetextField || isFreetextField(fieldPath);
        const result = checkForInjection(value, fieldPath, isFreetextCheckField);
        if (result) return result;
      }
      return null;
    }

    return null;
  }

  const injectionResult = checkForInjection(req.body) ?? checkForInjection(req.query) ?? checkForInjection(req.params);

  if (injectionResult) {
    res.status(400).json({
      error: 'invalid_input',
      message: `field '${injectionResult.field}' contains disallowed patterns`,
    });
    return;
  }

  next();
}

export function parameterPollutionProtection(req: Request, res: Response, next: NextFunction): void {
  if (hasParameterPollution(req.query)) {
    res.status(400).json({ error: 'invalid_input', message: 'duplicate query parameters detected' });
    return;
  }
  next();
}

const suspiciousIpCounts = new Map<string, { count: number; windowStart: number }>();
const SUSPICIOUS_WINDOW_MS = 60_000;
const SUSPICIOUS_THRESHOLD = 10;

export function suspiciousRateLimiting(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? '0.0.0.0';
  if (flagSuspiciousRequest(ip)) {
    res.status(429).json({ error: 'rate_limited', message: 'Too many suspicious requests' });
    return;
  }
  next();
}

export function flagSuspiciousRequest(ip: string): boolean {
  const now = Date.now();
  const record = suspiciousIpCounts.get(ip);

  if (!record || now - record.windowStart > SUSPICIOUS_WINDOW_MS) {
    suspiciousIpCounts.set(ip, { count: 1, windowStart: now });
    return false;
  }

  record.count++;
  if (record.count >= SUSPICIOUS_THRESHOLD) {
    return true;
  }

  return false;
}

export function xssErrorSanitizer(err: Error, _req: Request, res: Response, next: NextFunction): void {
  if (!res.headersSent) {
    const sanitized = sanitizeErrorMessage(err.message);
    res.status(500).json({ error: 'internal_server_error', message: sanitized });
  } else {
    next(err);
  }
}

export { sanitizeErrorMessage };

export function securityMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Chain security middleware checks in order of importance
  contentTypeEnforcement(req, res, () => {
    requestSizeLimiting(req, res, () => {
      injectionProtection(req, res, () => {
        parameterPollutionProtection(req, res, () => {
          suspiciousRateLimiting(req, res, next);
        });
      });
    });
  });
}
