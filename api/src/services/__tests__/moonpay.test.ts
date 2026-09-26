import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('MoonpayService', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env.MOONPAY_API_KEY = 'test-key';
    process.env.MOONPAY_SECRET_KEY = 'test-secret';
  });

  it('generates a widget url', async () => {
    const { MoonpayService } = await import('../moonpay');
    const service = new MoonpayService();
    const url = service.generateWidgetUrl({
      currencyCode: 'xlm',
      walletAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      walletNetwork: 'stellar',
    });
    expect(url).toContain('buy.moonpay.com');
    expect(url).toContain('apiKey=test-key');
    expect(url).toContain('walletAddress=');
  });

  it('generates url with optional params', async () => {
    const { MoonpayService } = await import('../moonpay');
    const service = new MoonpayService();
    const url = service.generateWidgetUrl({
      currencyCode: 'xlm',
      walletAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      walletNetwork: 'stellar',
      baseCurrencyAmount: 100,
      baseCurrencyCode: 'USD',
      email: 'test@example.com',
    });
    expect(url).toContain('baseCurrencyAmount=100');
    expect(url).toContain('baseCurrencyCode=USD');
    expect(url).toContain('email=test%40example.com');
  });

  it('appends HMAC-SHA256 signature when secretKey is present', async () => {
    const crypto = await import('crypto');
    const { MoonpayService } = await import('../moonpay');
    const service = new MoonpayService();
    const url = service.generateWidgetUrl({
      currencyCode: 'xlm',
      walletAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      walletNetwork: 'stellar',
    });

    const parsed = new URL(url);
    const signature = parsed.searchParams.get('signature');
    expect(signature).toBeDefined();
    expect(signature).not.toBeNull();

    parsed.searchParams.delete('signature');
    const expectedSig = crypto.default
      .createHmac('sha256', 'test-secret')
      .update(`?${parsed.searchParams.toString()}`)
      .digest('base64');
    expect(signature).toBe(expectedSig);
  });

  it('selects buy-sandbox.moonpay.com when sandbox flag is set', async () => {
    const { MoonpayService } = await import('../moonpay');
    const service = new MoonpayService();
    const url = service.generateWidgetUrl({
      currencyCode: 'xlm',
      walletAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      walletNetwork: 'stellar',
      sandbox: true,
    });

    expect(url.startsWith('https://buy-sandbox.moonpay.com')).toBe(true);
  });
});
