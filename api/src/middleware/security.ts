import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';

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

/**
 * RegExp.test is stateful for /g patterns (it advances lastIndex), so the
 * same payload could alternately match and not match across requests.
 * Reset lastIndex before every test.
 */
function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function detectPatterns(values: string[], patterns: RegExp[]): boolean {
  return values.some((v) => patterns.some((p) => testPattern(p, v)));
}

const MULTI_VALUED_QUERY_PARAMS = new Set([
  'status',
  'type',
]);

/** Upper bound on values for params that may legitimately repeat. */
const MAX_MULTI_VALUES = 20;

function hasParameterPollution(query: Record<string, unknown>): boolean {
  return Object.entries(query).some(([key, v]) => {
    // qs turns `a[b]=1` into an object: never a valid single value here.
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return true;
    if (!Array.isArray(v)) return false;
    if (!MULTI_VALUED_QUERY_PARAMS.has(key)) return true;
    return v.length > MAX_MULTI_VALUES || v.some((item) => typeof item !== 'string');
  });
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

/**
 * Fields whose values are binary/encoded payloads (base64 XDR, hex hashes,
 * addresses). These are validated structurally elsewhere, and their byte
 * sequences can legitimately match SQL/XSS regexes (e.g. padded base64
 * ending in `...onQx=` trips /on\w+\s*=/). Skip pattern checks for them.
 */
const ENCODED_FIELDS = new Set([
  'signedxdr',
  'xdr',
  'envelope',
  'envelopexdr',
  'transactionxdr',
  'hash',
  'txhash',
  'transactionhash',
  'signature',
  'signatures',
  'publickey',
  'address',
  'fromaddress',
  'toaddress',
  'sourceaccount',
  'destinationaccount',
  'contractid',
  'assetissuer',
  'assetcode',
]);

function isFreetextField(fieldPath: string): boolean {
  const fieldName = fieldPath.split('.').pop()?.toLowerCase() ?? '';
  return FREE_TEXT_FIELDS.has(fieldName);
}

function isEncodedField(fieldPath: string): boolean {
  const fieldName = fieldPath.split('.').pop()?.toLowerCase() ?? '';
  return ENCODED_FIELDS.has(fieldName);
}

export function injectionProtection(req: Request, res: Response, next: NextFunction): void {
  function checkForInjection(obj: unknown, path = '', isInFreetextField = false, isInEncodedField = false): { match: RegExp; field: string } | null {
    if (typeof obj === 'string') {
      // Encoded/binary fields (base64 XDR, hashes, addresses) are validated
      // structurally elsewhere; their bytes can match SQL/XSS regexes by
      // coincidence, so skip pattern checks entirely for them.
      if (isInEncodedField) {
        return null;
      }
      // Skip SQL patterns for freetext fields; always check NoSQL and XSS
      if (!isInFreetextField && detectPatterns([obj], SQL_PATTERNS)) {
        return { match: SQL_PATTERNS.find((p) => testPattern(p, obj)) as RegExp, field: path || 'unknown' };
      }
      if (detectPatterns([obj], NOSQL_PATTERNS)) {
        return { match: NOSQL_PATTERNS.find((p) => testPattern(p, obj)) as RegExp, field: path || 'unknown' };
      }
      if (detectPatterns([obj], XSS_PATTERNS)) {
        return { match: XSS_PATTERNS.find((p) => testPattern(p, obj)) as RegExp, field: path || 'unknown' };
      }
      return null;
    }

    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const result = checkForInjection(obj[i], `${path}[${i}]`, isInFreetextField, isInEncodedField);
        if (result) return result;
      }
      return null;
    }

    if (obj && typeof obj === 'object') {
      const objMap = obj as Record<string, unknown>;
      // Check keys for NoSQL operators like $where, $ne
      if (detectPatterns(Object.keys(objMap), NOSQL_PATTERNS)) {
        const badKey = Object.keys(objMap).find((k) => NOSQL_PATTERNS.some((p) => testPattern(p, k)));
        return { match: NOSQL_PATTERNS.find((p) => testPattern(p, badKey ?? '')) as RegExp, field: path ? `${path}.${badKey}` : badKey ?? 'unknown' };
      }

      for (const [key, value] of Object.entries(objMap)) {
        const childPath = path ? `${path}.${key}` : key;
        const result = checkForInjection(
          value,
          childPath,
          isInFreetextField || isFreetextField(childPath),
          isInEncodedField || isEncodedField(childPath),
        );
        if (result) return result;
      }
    }

    return null;
  }

  const sources: Array<{ name: string; data: unknown }> = [
    { name: 'body', data: req.body },
    { name: 'query', data: req.query },
    { name: 'params', data: req.params },
  ];

  for (const source of sources) {
    if (!source.data) continue;
    const result = checkForInjection(source.data, source.name);
    if (result) {
      logger.warn(
        { ip: req.ip, path: req.path, method: req.method, field: result.field, source: source.name },
        'rejected request with suspicious input pattern',
      );
      // Mark the request so suspiciousRateLimiting can count it (#620).
      (req as Request & { suspicious?: boolean }).suspicious = true;
      res.status(400).json({
        error: 'invalid_input',
        message: 'Request contains potentially malicious input',
      });
      return;
    }
  }

  next();
}

export function parameterPollutionProtection(req: Request, res: Response, next: NextFunction): void {
  if (hasParameterPollution(req.query as Record<string, unknown>)) {
    logger.warn(
      { ip: req.ip, path: req.path, method: req.method },
      'rejected request with parameter pollution',
    );
    (req as Request & { suspicious?: boolean }).suspicious = true;
    res.status(400).json({
      error: 'invalid_input',
      message: 'Request contains invalid query parameters',
    });
    return;
  }

  next();
}

/**
 * Composes the input-screening guards into a single middleware so index.ts
 * can mount them with one `app.use`. Order matters: cheap size check first,
 * then query-shape validation, then the pattern scan over body/query/params.
 */
export function securityMiddleware(req: Request, res: Response, next: NextFunction): void {
  requestSizeLimiting(req, res, (err?: unknown) => {
    if (err) {
      next(err);
      return;
    }
    if (res.headersSent) return;
    parameterPollutionProtection(req, res, (err2?: unknown) => {
      if (err2) {
        next(err2);
        return;
      }
      if (res.headersSent) return;
      injectionProtection(req, res, next);
    });
  });
}

interface SuspiciousBucket {
  count: number;
  resetAt: number;
}

const SUSPICIOUS_WINDOW_MS = 60 * 1000;
const SUSPICIOUS_MAX_PER_WINDOW = 10;
const suspiciousBuckets = new Map<string, SuspiciousBucket>();

/**
 * Throttles IPs that repeatedly trip a detector (#620). Only requests that
 * were flagged by injectionProtection/parameterPollutionProtection are
 * counted; clean traffic is never penalised. Mounted before
 * securityMiddleware so an already-throttled IP is rejected up front.
 */
export function suspiciousRateLimiting(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const bucket = suspiciousBuckets.get(key);

  if (bucket && bucket.resetAt > now && bucket.count >= SUSPICIOUS_MAX_PER_WINDOW) {
    logger.warn({ ip: key, path: req.path, method: req.method }, 'throttled suspicious IP');
    res.status(429).json({
      error: 'too_many_requests',
      message: 'Too many suspicious requests, please slow down',
    });
    return;
  }

  // Record the outcome after downstream handlers have run so we only count
  // requests that actually tripped a detector.
  res.on('finish', () => {
    if (!(req as Request & { suspicious?: boolean }).suspicious) return;
    const current = suspiciousBuckets.get(key);
    if (!current || current.resetAt <= now) {
      suspiciousBuckets.set(key, { count: 1, resetAt: now + SUSPICIOUS_WINDOW_MS });
    } else {
      current.count += 1;
    }
  });

  next();
}

/**
 * Strips HTML/script fragments from error messages before they are sent to
 * clients, so reflected input cannot execute in a browser.
 */
export function xssErrorSanitizer(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Internal server error';
  const sanitized = message
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '');

  logger.error({ err, ip: req.ip, path: req.path, method: req.method }, 'request failed');
  res.status(500).json({ error: 'internal_error', message: sanitized });
}
