/**
 * WebhookSimulator — signs payloads exactly as real providers do and sends
 * them to the running Express app via supertest.
 *
 * Moonpay:  x-moonpay-signature = base64(HMAC-SHA256(secret, rawBody))
 * Transak:  x-webhook-signature = "sha256=" + hex(HMAC-SHA256(secret, rawBody))
 */

import crypto from 'crypto';
import request, { type Test } from 'supertest';
import type { Express } from 'express';

export type Provider = 'moonpay' | 'transak';

interface SendOptions {
  /** Override the timestamp embedded in the payload (ms). Defaults to Date.now(). */
  timestamp?: number;
  /** Provide a pre-built raw string instead of serialising payload. */
  rawBody?: string;
  /** Use a different secret for the signature (simulates wrong/expired secret). */
  secret?: string;
  /** Skip adding the signature header (simulates unsigned request). */
  omitSignature?: boolean;
  /** Override the header value directly (simulates malformed / tampered signature). */
  signatureOverride?: string;
}

export class WebhookSimulator {
  constructor(
    private readonly app: Express,
    private readonly secrets: Record<Provider, string>,
  ) {}

  /** Compute the correct signature for a provider. */
  sign(provider: Provider, rawBody: string, secret?: string): string {
    const key = secret ?? this.secrets[provider];
    const hmac = crypto.createHmac('sha256', key).update(rawBody, 'utf8');
    if (provider === 'moonpay') return hmac.digest('base64');
    return `sha256=${hmac.digest('hex')}`;
  }

  /**
   * Send a webhook payload to /api/webhook/{provider}.
   * Returns the supertest Test so callers can chain .expect() assertions.
   */
  send(provider: Provider, payload: object, opts: SendOptions = {}): Test {
    // Patch timestamp so the replay-window check passes
    const body: Record<string, unknown> = { ...payload };
    const ts = opts.timestamp ?? Date.now();
    if (provider === 'transak') {
      body.webhookTimestamp = ts;
    }

    const raw = opts.rawBody ?? JSON.stringify(body);
    const signature = opts.omitSignature
      ? undefined
      : (opts.signatureOverride ?? this.sign(provider, raw, opts.secret));

    const sigHeader = provider === 'moonpay' ? 'x-moonpay-signature' : 'x-webhook-signature';

    const req = request(this.app)
      .post(`/api/webhook/${provider}`)
      .set('Content-Type', 'text/plain')
      .send(raw);

    if (signature !== undefined) req.set(sigHeader, signature);
    return req;
  }
}
