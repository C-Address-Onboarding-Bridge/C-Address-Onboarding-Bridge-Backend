import { describe, it, expect } from 'vitest';

import { createTransakWidgetUrl } from '../../../offramp/transak';

const config = { apiKey: 'pk_test_key', environment: 'STAGING' as const };
const walletAddress = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

describe('createTransakWidgetUrl (offramp module)', () => {
  it('builds a staging URL with required params', () => {
    const url = createTransakWidgetUrl(config, { walletAddress });
    expect(url).toContain('https://global-stg.transak.com?');
    expect(url).toContain(`apiKey=${config.apiKey}`);
    expect(url).toContain(`walletAddress=${walletAddress}`);
    expect(url).toContain('network=stellar');
  });

  it('uses the production endpoint when configured', () => {
    const url = createTransakWidgetUrl({ ...config, environment: 'PRODUCTION' }, { walletAddress });
    expect(url).toContain('https://global.transak.com?');
  });

  it('includes optional params when provided', () => {
    const url = createTransakWidgetUrl(config, {
      walletAddress,
      network: 'ethereum',
      fiatCurrency: 'USD',
      cryptoCurrency: 'USDC',
      fiatAmount: 100,
      email: 'test@example.com',
      redirectUrl: 'https://example.com/callback',
      partnerFee: 1.5,
    });
    expect(url).toContain('network=ethereum');
    expect(url).toContain('fiatCurrency=USD');
    expect(url).toContain('cryptoCurrency=USDC');
    expect(url).toContain('fiatAmount=100');
    expect(url).toContain('email=test%40example.com');
    expect(url).toContain('redirectURL=https%3A%2F%2Fexample.com%2Fcallback');
    expect(url).toContain('partnerFee=1.5');
  });

  it('omits optional params when not provided', () => {
    const url = createTransakWidgetUrl(config, { walletAddress });
    expect(url).not.toContain('fiatCurrency');
    expect(url).not.toContain('cryptoCurrency');
    expect(url).not.toContain('fiatAmount');
    expect(url).not.toContain('email');
    expect(url).not.toContain('redirectURL');
    expect(url).not.toContain('partnerFee');
  });

  it('always sets the branded theme color', () => {
    const url = createTransakWidgetUrl(config, { walletAddress });
    expect(url).toContain('themeColor=%237C3AED');
  });
});
