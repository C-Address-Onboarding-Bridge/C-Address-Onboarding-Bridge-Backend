import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyMoonpayWebhook, type MoonpayConfig } from './moonpay.js';

const config: MoonpayConfig = {
  apiKey: 'test-api-key',
  secretKey: 'test-secret',
  webhookKey: 'test-webhook-key',
};

function makeSignature(rawBody: string, timestamp: number, key: string): string {
  const payload = `${timestamp}.${rawBody}`;
  const hmac = crypto.createHmac('sha256', key).update(payload).digest('hex');
  return `t=${timestamp},s=${hmac}`;
}

describe('verifyMoonpayWebhook', () => {
  it('returns true for a valid fresh signature', () => {
    const body = JSON.stringify({ event: 'transaction_updated' });
    const ts = Date.now();
    const sig = makeSignature(body, ts, config.webhookKey!);
    expect(verifyMoonpayWebhook(config, body, sig)).toBe(true);
  });

  it('returns false when the body is tampered', () => {
    const body = JSON.stringify({ event: 'transaction_updated' });
    const ts = Date.now();
    const sig = makeSignature(body, ts, config.webhookKey!);
    expect(verifyMoonpayWebhook(config, body + 'x', sig)).toBe(false);
  });

  it('returns false for a stale timestamp (older than 5 min)', () => {
    const body = '{}';
    const ts = Date.now() - 6 * 60 * 1000;
    const sig = makeSignature(body, ts, config.webhookKey!);
    expect(verifyMoonpayWebhook(config, body, sig)).toBe(false);
  });

  it('returns false for a malformed header without t= or s=', () => {
    expect(verifyMoonpayWebhook(config, '{}', 'invalid')).toBe(false);
    expect(verifyMoonpayWebhook(config, '{}', 't=123')).toBe(false);
  });

  it('falls back to secretKey when webhookKey is absent', () => {
    const cfgNoWebhook: MoonpayConfig = { apiKey: 'k', secretKey: 'test-webhook-key' };
    const body = '{"ok":true}';
    const ts = Date.now();
    const sig = makeSignature(body, ts, 'test-webhook-key');
    expect(verifyMoonpayWebhook(cfgNoWebhook, body, sig)).toBe(true);
  });
});
