import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { createMoonpayWidgetUrl, verifyMoonpayWebhook } from './moonpay';

describe('createMoonpayWidgetUrl', () => {
  it('uses standard base64 (not base64url) for signature', () => {
    const config = { apiKey: 'pk_test_key', secretKey: 'test_secret' };
    const params = {
      walletAddress: 'GABCD1234',
      walletNetwork: 'stellar',
      currencyCode: 'xlm',
    };
    const url = createMoonpayWidgetUrl(config, params);
    expect(url).toContain('buy.moonpay.com');
    expect(url).toContain('signature=');
    // Verify signature is correct standard base64 URL-encoded
    const urlObj = new URL(url);
    const sig = urlObj.searchParams.get('signature');
    expect(sig).not.toBeNull();
    // sig should be valid standard base64 when decoded
    const decoded = Buffer.from(sig!, 'base64');
    expect(decoded.length).toBe(32); // SHA-256 = 32 bytes
  });

  it('signature matches manual HMAC-SHA256 computation', () => {
    const config = { apiKey: 'pk_test_key', secretKey: 'supersecret' };
    const params = { walletAddress: 'GTEST', walletNetwork: 'stellar' };
    const url = createMoonpayWidgetUrl(config, params);

    // Extract query string without the &signature= part
    const urlStr = url;
    const sigIndex = urlStr.lastIndexOf('&signature=');
    const queryString = urlStr.substring('https://buy.moonpay.com'.length, sigIndex);

    const expectedSig = crypto
      .createHmac('sha256', config.secretKey)
      .update(queryString)
      .digest('base64');

    const urlObj = new URL(url);
    const actualSig = urlObj.searchParams.get('signature')!;
    expect(actualSig).toBe(expectedSig);
  });
});

describe('verifyMoonpayWebhook', () => {
  it('returns true for valid signature', () => {
    const config = { apiKey: 'pk', secretKey: 'secret' };
    const body = '{"type":"transaction_updated"}';
    const sig = crypto.createHmac('sha256', config.secretKey).update(body).digest('hex');
    expect(verifyMoonpayWebhook(config, body, sig)).toBe(true);
  });

  it('returns false for invalid signature', () => {
    const config = { apiKey: 'pk', secretKey: 'secret' };
    expect(verifyMoonpayWebhook(config, 'body', 'badsig')).toBe(false);
  });
});
