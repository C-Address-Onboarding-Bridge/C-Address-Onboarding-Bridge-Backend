import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

import { verifyMoonpayWebhook } from '../../../offramp/moonpay';

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
