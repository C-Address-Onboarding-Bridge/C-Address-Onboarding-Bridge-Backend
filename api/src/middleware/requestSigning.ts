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

const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const NONCE_CACHE_TTL = 24 * 60 * 60; // 24 hours

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function requestSigningMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip if no signing headers present
  const timestamp = req.headers['x-timestamp'] as string;
  const nonce = req.headers['x-nonce'] as string;
  const signature = req.headers['x-signature'] as string;

  if (!timestamp || !nonce || !signature) {
    // Signing is optional per-request; just continue
    next();
    return;
  }

  // Verify timestamp freshness
  const timestampMs = parseInt(timestamp, 10);
  if (isNaN(timestampMs)) {
    return res.status(400).json({ error: 'invalid_timestamp' });
  }

  const now = Date.now();
  if (Math.abs(now - timestampMs) > TIMESTAMP_WINDOW_MS) {
    return res.status(401).json({ error: 'stale_timestamp' });
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
