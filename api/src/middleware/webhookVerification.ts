import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';
import { getCacheClient } from '../services/cache';
import { maskHeaders } from './logging';

export interface WebhookVerifier {
  headerName: string;
  verify(_payload: string, _signature: string, _secret: string): boolean;
}

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

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
  VERIFIERS[provider] = { verifier, secret };
}

async function checkReplaySignature(provider: string, signature: string): Promise<boolean> {
  const redis = getCacheClient();
  if (!redis) {
    logger.warn({ provider }, 'redis not configured, replay detection disabled');
    return false;
  }

  const key = `webhook:replay:${provider}:${crypto.createHash('sha256').update(signature).digest('hex')}`;
  const ttlSeconds = Math.ceil(REPLAY_WINDOW_MS / 1000);

  try {
    const exists = await redis.get(key);
    if (exists) return true;

    await redis.setex(key, ttlSeconds, '1');
    return false;
  } catch (err) {
    logger.warn({ provider, err }, 'replay check failed, allowing webhook');
    return false;
  }
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
      const isReplay = await checkReplaySignature(provider, signature);
      if (isReplay) {
        logger.warn({ ip, provider, path: req.path }, 'webhook replay detected');
        res.status(401).json({ error: 'unauthorized', message: 'webhook already processed' });
        return;
      }
      next();
    })().catch(() => next());
  };
}

export const verifyMoonpayWebhook = buildWebhookVerifier('moonpay');
export const verifyTransakWebhook = buildWebhookVerifier('transak');
