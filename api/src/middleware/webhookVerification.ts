import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../index';

export interface WebhookVerifier {
  headerName: string;
  verify(_payload: string, _signature: string, _secret: string): boolean;
}

const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const replayNonces = new Map<string, number>();

function purgeExpiredNonces(): void {
  const cutoff = Date.now() - REPLAY_WINDOW_MS;
  for (const [nonce, ts] of replayNonces) {
    if (ts < cutoff) replayNonces.delete(nonce);
  }
}

function hmacSha256Base64(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64');
}

function hmacSha256Hex(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export const moonpayVerifier: WebhookVerifier = {
  headerName: 'x-moonpay-signature',
  verify(payload, signature, secret) {
    const expected = hmacSha256Base64(secret, payload);
    return timingSafeCompare(expected, signature);
  },
};

export const transakVerifier: WebhookVerifier = {
  headerName: 'x-webhook-signature',
  verify(payload, signature, secret) {
    const expected = `sha256=${hmacSha256Hex(secret, payload)}`;
    return timingSafeCompare(expected, signature);
  },
};

const VERIFIERS: Record<string, { verifier: WebhookVerifier; secret: string }> = {};

export function registerWebhookVerifier(provider: string, verifier: WebhookVerifier, secret: string): void {
  VERIFIERS[provider] = { verifier, secret };
}

const failedAttempts = new Map<string, { count: number; windowStart: number }>();
const FAIL_WINDOW_MS = 60_000;
const FAIL_LIMIT = 10;

function recordFailedAttempt(ip: string): boolean {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now - entry.windowStart > FAIL_WINDOW_MS) {
    failedAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > FAIL_LIMIT;
}

function buildWebhookVerifier(provider: string) {
  return function verifyWebhook(req: Request, res: Response, next: NextFunction): void {
    const entry = VERIFIERS[provider];
    if (!entry) {
      res.status(500).json({ error: 'provider_not_configured', provider });
      return;
    }

    const { verifier, secret } = entry;
    const signature = req.headers[verifier.headerName] as string | undefined;
    const ip = req.ip ?? 'unknown';

    if (!signature) {
      logger.warn({ ip, provider, path: req.path, headers: req.headers }, 'webhook missing signature header');
      res.status(401).json({ error: 'unauthorized', message: 'missing webhook signature' });
      return;
    }

    const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    // Timestamp validation: Transak embeds timestamp in payload JSON; extract if present
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const ts = parsed.webhookTimestamp ?? parsed.timestamp ?? parsed.createdAt;
      if (ts && typeof ts === 'number') {
        const age = Date.now() - ts;
        if (age > REPLAY_WINDOW_MS || age < -30_000) {
          logger.warn({ ip, provider, ts, age }, 'webhook timestamp outside acceptable window');
          res.status(401).json({ error: 'unauthorized', message: 'webhook timestamp expired or invalid' });
          return;
        }
      }
    } catch {
      // not JSON or no timestamp — proceed to HMAC check
    }

    // Replay attack prevention using signature as nonce
    purgeExpiredNonces();
    if (replayNonces.has(signature)) {
      logger.warn({ ip, provider, path: req.path }, 'webhook replay detected');
      res.status(401).json({ error: 'unauthorized', message: 'webhook already processed' });
      return;
    }

    const valid = verifier.verify(payload, signature, secret);
    if (!valid) {
      const blocked = recordFailedAttempt(ip);
      logger.warn(
        { ip, provider, path: req.path, userAgent: req.headers['user-agent'], blocked },
        'webhook signature verification failed',
      );
      if (blocked) {
        res.status(429).json({ error: 'rate_limited', message: 'too many failed verification attempts' });
        return;
      }
      res.status(401).json({ error: 'unauthorized', message: 'invalid webhook signature' });
      return;
    }

    replayNonces.set(signature, Date.now());
    next();
  };
}

export const verifyMoonpayWebhook = buildWebhookVerifier('moonpay');
export const verifyTransakWebhook = buildWebhookVerifier('transak');
