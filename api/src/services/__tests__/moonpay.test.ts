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
});
