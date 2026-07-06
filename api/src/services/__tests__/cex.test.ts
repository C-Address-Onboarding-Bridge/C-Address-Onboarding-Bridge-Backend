import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockFetch = vi.fn();

describe('CexRoutingService', () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockClear();
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ id: 'mock-withdrawal-id', txId: 'mock-tx-hash' }),
      text: vi.fn().mockResolvedValue('ok'),
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes a binance withdrawal', async () => {
    const { CexRoutingService } = await import('../cex');
    const service = new CexRoutingService();
    const result = await service.routeWithdrawal({
      exchange: 'binance',
      sourceAsset: 'XLM',
      amount: '10000000',
      targetCAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      targetNetwork: 'stellar',
    });
    expect(result).toHaveProperty('withdrawalId');
    expect(result.withdrawalId).toContain('bin-');
    expect(result.status).toBe('pending');
  });

  it('routes a coinbase withdrawal', async () => {
    const { CexRoutingService } = await import('../cex');
    const service = new CexRoutingService();
    const result = await service.routeWithdrawal({
      exchange: 'coinbase',
      sourceAsset: 'USDC',
      amount: '5000000',
      targetCAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      targetNetwork: 'stellar',
    });
    expect(result.withdrawalId).toContain('cb-');
  });

  it('throws for unsupported exchange', async () => {
    const { CexRoutingService } = await import('../cex');
    const service = new CexRoutingService();
    await expect(service.routeWithdrawal({
      exchange: 'unknown' as any,
      sourceAsset: 'XLM',
      amount: '1000',
      targetCAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      targetNetwork: 'stellar',
    })).rejects.toThrow('unsupported exchange');
  });

  it('passes configured exchange credentials to the API call', async () => {
    process.env.BINANCE_API_KEY = 'binance-key';
    process.env.BINANCE_API_SECRET = 'binance-secret';
    const { CexRoutingService } = await import('../cex');
    const service = new CexRoutingService();
    await service.routeWithdrawal({
      exchange: 'binance',
      sourceAsset: 'XLM',
      amount: '10000000',
      targetCAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      targetNetwork: 'stellar',
    });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['X-API-Key']).toBe('binance-key');
    expect(init.headers['X-API-Secret']).toBe('binance-secret');
    delete process.env.BINANCE_API_KEY;
    delete process.env.BINANCE_API_SECRET;
  });

  it('returns status failed (not a success-looking result) when the exchange responds non-2xx', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({ msg: 'unauthorized' }),
      text: vi.fn().mockResolvedValue('unauthorized'),
    });
    const { CexRoutingService } = await import('../cex');
    const service = new CexRoutingService();
    const result = await service.routeWithdrawal({
      exchange: 'binance',
      sourceAsset: 'XLM',
      amount: '10000000',
      targetCAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      targetNetwork: 'stellar',
    });
    expect(result.status).toBe('failed');
    expect(result.exchangeTxId).toBeUndefined();
    expect(result.estimatedArrival).toBeUndefined();
  });

  it('lists supported exchanges', async () => {
    const { CexRoutingService } = await import('../cex');
    const service = new CexRoutingService();
    const exchanges = service.getSupportedExchanges();
    expect(exchanges).toContain('binance');
    expect(exchanges).toContain('coinbase');
    expect(exchanges).toContain('kraken');
    expect(exchanges).toContain('generic');
  });
});
