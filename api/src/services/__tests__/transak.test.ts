import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('TransakService', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env.TRANSAK_API_KEY = 'test-key';
    process.env.TRANSAK_ENVIRONMENT = 'STAGING';
  });

  it('generates a widget url', async () => {
    const { TransakService } = await import('../transak');
    const service = new TransakService();
    const url = service.generateWidgetUrl({
      walletAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      network: 'stellar',
    });
    expect(url).toContain('global-stg.transak.com');
    expect(url).toContain('apiKey=test-key');
    expect(url).toContain('walletAddress=');
  });

  it('supports setting a partner fee', async () => {
    const { TransakService } = await import('../transak');
    const service = new TransakService();
    const url = service.generateWidgetUrl({
      walletAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      network: 'stellar',
      partnerFee: 1.5,
    });
    expect(url).toContain('partnerFee=1.5');
  });

  it('defaults to the standard branded theme color', async () => {
    const { TransakService } = await import('../transak');
    const service = new TransakService();
    const url = service.generateWidgetUrl({
      walletAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      network: 'stellar',
    });
    expect(url).toContain('themeColor=%237C3AED');
  });

  it('allows overriding the theme color', async () => {
    const { TransakService } = await import('../transak');
    const service = new TransakService();
    const url = service.generateWidgetUrl({
      walletAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      network: 'stellar',
      themeColor: '#000000',
    });
    expect(url).toContain('themeColor=%23000000');
  });
});
