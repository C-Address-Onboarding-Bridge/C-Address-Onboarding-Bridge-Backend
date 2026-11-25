import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../logger';
import { cacheSetNX } from '../services/cache';
import { config } from '../config';
import { resolveRecord } from './rbacAuth';

/**
 * Issue #673 / #860: Verify request signing headers (X-Timestamp, X-Nonce, X-Signature).
 * This middleware validates HMAC-SHA256 signatures on requests when signing is enabled.
 *
 * Security fixes (#860):
 * - HMAC key is the per-key signing secret (config.signingSecret), not the API key itself.
 *   The API key is transmitted in the same request, so using it as the HMAC key proves
 *   nothing beyond key possession.
 * - Signature is verified BEFORE the nonce is cached, so a junk signature cannot burn
 *   another client's nonce.
 * - Nonces are scoped to the API key id (nonce:<keyId>:<nonce>), not global, so one
 *   client cannot exhaust another client's nonce space.
 * - Cache errors return 503 instead of silently skipping verification.
 */
function serializeSortedQuery(query: Record<string, unknown> | undefined): string {
  if (!query) {
    return '';
  }
  const keys = Object.keys(query).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const value = query[key];
    if (value === undefined || value === null) {
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

/**
 * Build the canonical signing payload. Must stay in sync with the SDK's
 * `buildSigningPayload` in sdk/src/bridge.ts.
 */
export function buildSigningPayload(
  method: string,
  path: string,
  query: Record<string, unknown> | undefined,
  bodyStr: string,
  timestamp: string,
  nonce: string
): string {
  const sortedQuery = serializeSortedQuery(query);
  return `${method.toUpperCase()}.${path}.${sortedQuery}.${bodyStr}.${timestamp}.${nonce}`;
}

/** Max allowed clock skew between client timestamp and server time, in seconds. */
const MAX_CLOCK_SKEW_SECONDS = 300;

/** How long a used nonce is remembered to reject replays, in seconds. */
const NONCE_CACHE_TTL = MAX_CLOCK_SKEW_SECONDS * 2;

/** Paths that must never require request signing (provider webhooks, docs, telemetry). */
const SIGNING_EXEMPT_PREFIXES = ['/api/webhook/', '/api/docs', '/api/openapi.json', '/api/telemetry'];

function isSigningExempt(path: string): boolean {
  return SIGNING_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function requestSigningMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (isSigningExempt(req.originalUrl.split('?')[0] ?? req.path)) {
    next();
    return;
  }

  const signature = req.header('X-Signature');
  const timestamp = req.header('X-Timestamp');
  const nonce = req.header('X-Nonce');

  if (!signature || !timestamp || !nonce) {
    if (!config.requestSigningRequired) {
      next();
      return;
    }
    res.status(401).json({ error: 'missing_signature' });
    return;
  }

  // Timestamps are sent in milliseconds (matches sdk/src/bridge.ts: String(Date.now())).
  const now = Date.now();
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_SECONDS * 1000) {
    res.status(401).json({ error: 'invalid_timestamp' });
    return;
  }

  const apiKey = req.headers['x-api-key'] as string;
  if (!apiKey) {
    return res.status(401).json({ error: 'missing_api_key' });
  }

  // Per-key signing secret (#1026): every tenant gets a distinct HMAC key
  // generated at key creation, so one tenant's key cannot be used to sign
  // requests as another tenant. The global REQUEST_SIGNING_SECRET /
  // config.signingSecret is only a fallback for keys created before this
  // field existed, and only outside production.
  const keyRecord = resolveRecord(apiKey);
  const envSecret = process.env.REQUEST_SIGNING_SECRET || config.signingSecret;
  const signingKey = keyRecord?.signingSecret || (process.env.NODE_ENV !== 'production' ? envSecret : undefined);
  if (!signingKey) {
    res.status(500).json({ error: 'signing_not_configured' });
    return;
  }

  // Use the raw bytes the client sent (captured by the express.json() verify
  // hook in index.ts), not a re-stringified req.body: key order/whitespace
  // differences would otherwise fail verification even for an unmodified body.
  const bodyStr = (req as Request & { rawBody?: string }).rawBody ?? '';
  const payload = buildSigningPayload(req.method, req.path, req.query as Record<string, unknown>, bodyStr, timestamp, nonce);

  const expectedSig = crypto.createHmac('sha256', signingKey).update(payload).digest('hex');
  const sigFormat = signature.startsWith('sha256=') ? signature.slice(7) : signature;

  if (!constantTimeCompare(expectedSig, sigFormat)) {
    logger.warn('Invalid request signature', { apiKey: apiKey.slice(0, 8) + '...' });
    return res.status(401).json({ error: 'invalid_signature' });
  }

  // Signature verified — now atomically reserve the nonce to prevent replay.
  // Scope nonce to the hashed API key id so one client cannot burn another's
  // nonces, and never store the raw key in Redis.
  const keyId =
    (req as Request & { apiKey?: { id?: string } }).apiKey?.id ??
    crypto.createHash('sha256').update(apiKey).digest('hex');
  const nonceKey = `nonce:${keyId}:${nonce}`;

  cacheSetNX(nonceKey, '1', NONCE_CACHE_TTL)
    .then((reserved) => {
      if (!reserved) {
        res.status(401).json({ error: 'replay_nonce' });
        return;
      }
      next();
    })
    .catch((err) => {
      logger.warn('Error verifying request signature', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).json({ error: 'signature_service_unavailable' });
    });
}
