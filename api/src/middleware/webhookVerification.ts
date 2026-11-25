import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';
import { getCacheClient } from '../services/cache';
import { maskHeaders } from './logging';

export interface WebhookVerifier {
  headerName: string;
  verify(_payload: string, _signature: string, _secret: string): boolean;
}

// Dedupe window independent of the 5-minute Transak/Moonpay timestamp
// tolerance used for signature freshness. Replay protection itself must
// outlive any realistic retry/late-delivery window, not just 5 minutes.
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const REPLAY_DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

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
  headerName: 'moonpay-signature-v2',
  verify(payload, signature, secret) {
    const signaturePart = signature.split(',').find((part) => part.startsWith('s='));
    if (!signaturePart) return false;

    const s = signaturePart.slice(2);
    const tPart = signature.split(',').find((part) => part.startsWith('t='));
    if (!tPart) return false;

    const t = tPart.slice(2);
    const timestamp = parseInt(t, 10);
    const now = Date.now();
    const age = now - timestamp * 1000;

    if (age > REPLAY_WINDOW_MS || age < -30_000) return false;

    const signedPayload = `${t}.${payload}`;
    const expected = hmacSha256Base64(secret, signedPayload);
    return timingSafeCompare(expected, s);
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
  // Re-registering a provider replaces its entry, which is what secret rotation
  // needs: the new secret takes effect without a restart. buildWebhookVerifier
  // reads VERIFIERS per request rather than closing over the entry, so the
  // exported verifyMoonpayWebhook / verifyTransakWebhook handlers pick this up
  // even though they were created at module load.
  if (!secret) {
    delete VERIFIERS[provider];
    return;
  }
  VERIFIERS[provider] = { verifier, secret };
}

/**
 * Result of a replay check: 'fresh' (first time seen, now recorded),
 * 'replay' (already seen), or 'unavailable' (storage could not be reached,
 * so the caller must decide how to fail).
 */
type ReplayCheckResult = 'fresh' | 'replay' | 'unavailable';

async function checkReplaySignature(provider: string, signature: string, payload: string): Promise<ReplayCheckResult> {
  const redis = getCacheClient();
  if (!redis) {
    return 'unavailable';
  }

  // Dedupe on a hash of the full payload + signature, not just the
  // signature, so two distinct events never collide. No short TTL: replay
  // protection must not expire while the signed body itself stays valid
  // indefinitely (Transak's signature has no embedded timestamp).
  const key = `webhook:replay:${provider}:${crypto.createHash('sha256').update(`${signature}:${payload}`).digest('hex')}`;

  try {
    // SET ... NX is atomic: only the first caller to reach Redis for a given
    // key gets 'OK' back, so concurrent duplicate deliveries can't both pass.
    const set = await redis.set(key, '1', 'EX', REPLAY_DEDUPE_TTL_SECONDS, 'NX');
    return set ? 'fresh' : 'replay';
  } catch (err) {
    logger.error({ provider, err }, 'replay check failed');
    return 'unavailable';
  }
}

function buildWebhookVerifier(provider: string) {
  return function verifyWebhook(req: Request, res: Response, next: NextFunction): void {
    const entry = VERIFIERS[provider];
    if (!entry) {
      res.status(503).json({ error: 'provider_not_configured', provider });
      return;
    }

    const { verifier, secret } = entry;
    const signature = req.headers[verifier.headerName] as string | undefined;
    const ip = req.ip ?? 'unknown';

    if (!signature) {
      logger.warn(
        { ip, provider, path: req.path, headers: maskHeaders(req.headers as Record<string, string | string[] | undefined>) },
        'webhook missing signature header',
      );
      res.status(401).json({ error: 'unauthorized', message: 'missing webhook signature' });
      return;
    }

    const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    const valid = verifier.verify(payload, signature, secret);
    if (!valid) {
      logger.warn(
        { ip, provider, path: req.path, userAgent: req.headers['user-agent'] },
        'webhook signature verification failed',
      );
      res.status(401).json({ error: 'unauthorized', message: 'invalid webhook signature' });
      return;
    }

    (async () => {
      const replayResult = await checkReplaySignature(provider, signature, payload);
      if (replayResult === 'replay') {
        logger.warn({ ip, provider, path: req.path }, 'webhook replay detected');
        res.status(401).json({ error: 'unauthorized', message: 'webhook already processed' });
        return;
      }
      if (replayResult === 'unavailable') {
        // Fail closed in production: without working replay storage we
        // cannot tell a replay from a fresh event, and a signed body stays
        // valid indefinitely (no embedded timestamp for Transak), so letting
        // it through is unsafe. Non-production environments (no Redis
        // configured locally/in CI) still fail open so they keep working.
        if (process.env.NODE_ENV === 'production') {
          logger.error({ ip, provider, path: req.path }, 'replay storage unavailable, rejecting webhook');
          res.status(503).json({ error: 'service_unavailable', message: 'replay protection unavailable' });
          return;
        }
        logger.warn({ ip, provider, path: req.path }, 'replay storage unavailable, allowing webhook (non-production)');
      }
      next();
    })().catch((err) => {
      logger.error({ ip, provider, path: req.path, err }, 'webhook verification pipeline failed');
      if (process.env.NODE_ENV === 'production') {
        res.status(503).json({ error: 'service_unavailable' });
        return;
      }
      next();
    });
  };
}

export const verifyMoonpayWebhook = buildWebhookVerifier('moonpay');
export const verifyTransakWebhook = buildWebhookVerifier('transak');
