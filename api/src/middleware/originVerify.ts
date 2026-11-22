import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import crypto from 'crypto';

/**
 * Middleware that enforces the X-Origin-Verify header set by CloudFront.
 * When ORIGIN_VERIFY_SECRET is configured, requests without a matching
 * header are rejected with 403, preventing clients from bypassing the CDN
 * and hitting the origin directly.
 *
 * Uses constant-time comparison (timingSafeEqual) to avoid timing attacks
 * on the secret comparison.
 */
export function originVerifyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = config.originVerifySecret;

  // When no secret is configured, the check is disabled (backwards compatible).
  if (!secret) {
    next();
    return;
  }

  const provided = req.headers['x-origin-verify'] as string | undefined;

  if (!provided) {
    logger.warn('origin_verify_missing_header', {
      ip: req.ip,
      path: req.path,
      method: req.method,
    });
    res.status(403).json({ error: 'origin_verification_required' });
    return;
  }

  // Constant-time comparison to avoid timing attacks.
  const secretBuf = Buffer.from(secret, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');

  if (secretBuf.length !== providedBuf.length || !crypto.timingSafeEqual(secretBuf, providedBuf)) {
    logger.warn('origin_verify_invalid_header', {
      ip: req.ip,
      path: req.path,
      method: req.method,
    });
    res.status(403).json({ error: 'origin_verification_failed' });
    return;
  }

  next();
}
