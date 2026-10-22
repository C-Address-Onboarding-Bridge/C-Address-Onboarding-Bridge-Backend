import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

import { verifyMoonpayWebhook } from '../../../offramp/moonpay';
import { MoonpayService } from '../services/moonpay';

const config = { apiKey: 'pk_test_key', secretKey: 'sk_test_secret' };

function sign(body: string): string {
  return crypto.createHmac('sha256', config.secretKey).update(body).digest('base64');
}

describe('verifyMoonpayWebhook (offramp module)', () => {
  it('returns true for a valid signature', () => {
    const body = JSON.stringify({ type: 'transaction_updated' });
    expect(verifyMoonpayWebhook(config, body, sign(body))).toBe(true);
  });

  it('returns false for a tampered body', () => {
    const body = JSON.stringify({ type: 'transaction_updated' });
    expect(verifyMoonpayWebhook(config, body + 'x', sign(body))).toBe(false);
  });

  it('returns false (not throw) when the signature length differs', () => {
    const body = JSON.stringify({ type: 'transaction_updated' });
    expect(() => verifyMoonpayWebhook(config, body, 'short-sig')).not.toThrow();
    expect(verifyMoonpayWebhook(config, body, 'short-sig')).toBe(false);
    expect(verifyMoonpayWebhook(config, body, '')).toBe(false);
  });
});

describe('MoonpayService.generateWidgetUrl signing', () => {
  const service = new MoonpayService({
    apiKey: 'pk_test_key',
    secretKey: 'sk_test_secret',
    sandbox: false,
  });

  it('appends a base64 HMAC-SHA256 signature over the query string', () => {
    const url = service.generateWidgetUrl({
      walletAddress: '0xabc123',
      currencyCode: 'eth',
    });

    const parsed = new URL(url);
    const signature = parsed.searchParams.get('signature');
    expect(signature).toBeTruthy();

    // Recompute the signature over the query string (everything after '?')
    const query = url.slice(url.indexOf('?') + 1);
    const queryWithoutSig = query.replace(/&?signature=[^&]*/, '');
    const expected = crypto
      .createHmac('sha256', 'sk_test_secret')
      .update('?' + queryWithoutSig)
      .digest('base64');

    expect(signature).toBe(expected);
  });

  it('uses the production host by default', () => {
    const url = service.generateWidgetUrl({ walletAddress: '0xabc123' });
    expect(new URL(url).host).toBe('buy.moonpay.com');
  });

  it('uses the sandbox host when sandbox is enabled', () => {
    const sandboxService = new MoonpayService({
      apiKey: 'pk_test_key',
      secretKey: 'sk_test_secret',
      sandbox: true,
    });
    const url = sandboxService.generateWidgetUrl({ walletAddress: '0xabc123' });
    expect(new URL(url).host).toBe('buy-sandbox.moonpay.com');
  });
});
