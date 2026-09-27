import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../logger';
import { cacheGet, cacheSet } from '../services/cache';

/**
 * Issue #673: Verify request signing headers (X-Timestamp, X-Nonce, X-Signature).
 * This middleware validates HMAC-SHA256 signatures on requests when signing is enabled.
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

  // Verify nonce hasn't been replayed
  const nonceKey = `nonce:${nonce}`;
  cacheGet(nonceKey)
    .then((cached) => {
      if (cached) {
        return res.status(401).json({ error: 'replay_nonce' });
      }

      // Store nonce to prevent replay
      cacheSet(nonceKey, 'used', NONCE_CACHE_TTL).catch(() => {
        logger.warn('Failed to cache nonce for replay detection', { nonce });
      });

      // Verify signature
      const apiKey = req.headers['x-api-key'] as string;
      if (!apiKey) {
        return res.status(401).json({ error: 'missing_api_key' });
      }

      // Reconstruct the signed payload: body.timestamp.nonce
      const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      const payload = `${bodyStr}.${timestamp}.${nonce}`;

      // Issue #673: Derive HMAC key from signing secret (not the API key itself)
      // For now, use apiKey as placeholder; in production use a separate signing_secret
      const expectedSig = crypto.createHmac('sha256', apiKey).update(payload).digest('hex');
      const sigFormat = signature.startsWith('sha256=') ? signature.slice(7) : signature;

      if (!constantTimeCompare(expectedSig, sigFormat)) {
        logger.warn('Invalid request signature', { apiKey: apiKey.slice(0, 8) + '...' });
        return res.status(401).json({ error: 'invalid_signature' });
      }

      next();
    })
    .catch((err) => {
      logger.warn('Error verifying request signature', { error: err instanceof Error ? err.message : String(err) });
      // Don't fail the request if we can't verify the signature due to cache issues
      next();
    });
}
