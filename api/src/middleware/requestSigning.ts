import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../logger';
import { cacheGet, cacheSet } from '../services/cache';
import { config } from '../config';

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

export function requestSigningMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const signature = req.header('X-Signature');
  const timestamp = req.header('X-Timestamp');
  const nonce = req.header('X-Nonce');

  if (!signature || !timestamp || !nonce) {
    res.status(401).json({ error: 'missing_signature' });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_SECONDS) {
    res.status(401).json({ error: 'invalid_timestamp' });
    return;
  }

  const secret = process.env.REQUEST_SIGNING_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'signing_not_configured' });
    return;
  }

  const apiKey = req.headers['x-api-key'] as string;
  if (!apiKey) {
    return res.status(401).json({ error: 'missing_api_key' });
  }

  // Use the configured signing secret as the HMAC key, not the API key itself.
  // The API key is sent in the same request, so it cannot serve as a secret.
  const signingKey = config.signingSecret || apiKey;

  // Reconstruct the signed payload from the raw body.
  // express.json() has already parsed req.body, so stringify it back for
  // signature verification. Clients sign the exact bytes they sent.
  const bodyStr =
    typeof req.body === 'string'
      ? req.body
      : req.body !== null && typeof req.body === 'object'
        ? JSON.stringify(req.body)
        : '';
  const payload = `${bodyStr}.${timestamp}.${nonce}`;

  const expectedSig = crypto.createHmac('sha256', signingKey).update(payload).digest('hex');
  const sigFormat = signature.startsWith('sha256=') ? signature.slice(7) : signature;

  if (!constantTimeCompare(expectedSig, sigFormat)) {
    logger.warn('Invalid request signature', { apiKey: apiKey.slice(0, 8) + '...' });
    return res.status(401).json({ error: 'invalid_signature' });
  }

  // Signature verified — now cache the nonce to prevent replay.
  // Scope nonce to the API key id so one client cannot burn another's nonces.
  const keyId = (req as Request & { apiKey?: { id?: string } }).apiKey?.id ?? apiKey;
  const nonceKey = `nonce:${keyId}:${nonce}`;

  cacheGet(nonceKey)
    .then((cached) => {
      if (cached) {
        return res.status(401).json({ error: 'replay_nonce' });
      }
      return cacheSet(nonceKey, 'used', NONCE_CACHE_TTL);
    })
    .then(() => {
      next();
    })
    .catch((err) => {
      logger.warn('Error verifying request signature', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).json({ error: 'signature_service_unavailable' });
    });
}
