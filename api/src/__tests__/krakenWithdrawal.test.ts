import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  defaultCexHandlers,
  stroopsToDecimal,
  type WithdrawalRequest,
  type CexConfig,
} from '../../../cex/withdrawal-router';

describe('Kraken withdrawal handler (#877)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const request: WithdrawalRequest = {
    destinationAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    asset: 'XLM',
    amount: '10000000', // 1 XLM in stroops
    network: 'stellar',
  };

  const config: CexConfig = {
    name: 'kraken',
    apiBaseUrl: 'https://api.kraken.com',
    apiKey: 'test-api-key',
    apiSecret: Buffer.from('test-secret').toString('base64'),
    withdrawKey: 'pre-registered-kraken-key',
  };

  it('handles HTTP 200 with an error array as failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        error: ['EFunding:Unknown withdraw key'],
        result: {},
      }),
    } as unknown as Response);

    const result = await defaultCexHandlers.kraken(request, config);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('EFunding:Unknown withdraw key');
  });

  it('returns successful refid as withdrawalId on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        error: [],
        result: { refid: 'AG123456789' },
      }),
    } as unknown as Response);

    const result = await defaultCexHandlers.kraken(request, config);

    expect(result.success).toBe(true);
    expect(result.status).toBe('pending');
    expect(result.withdrawalId).toBe('AG123456789');
  });

  it('maps destination address to configured withdrawKey in the request body', async () => {
    let capturedBody = '';
    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = options?.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          error: [],
          result: { refid: 'REF-KEY-OK' },
        }),
      } as unknown as Response;
    });

    await defaultCexHandlers.kraken(request, config);

    const parsedParams = new URLSearchParams(capturedBody);
    expect(parsedParams.get('key')).toBe('pre-registered-kraken-key');
    expect(parsedParams.get('key')).not.toBe(request.destinationAddress);
  });

  it('maps destination address via withdrawKeys dictionary', async () => {
    let capturedBody = '';
    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = options?.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          error: [],
          result: { refid: 'REF-KEY-MAP-OK' },
        }),
      } as unknown as Response;
    });

    const configWithMap: CexConfig = {
      ...config,
      withdrawKeys: {
        [request.destinationAddress]: 'mapped-key-for-c-address',
      },
    };

    await defaultCexHandlers.kraken(request, configWithMap);

    const parsedParams = new URLSearchParams(capturedBody);
    expect(parsedParams.get('key')).toBe('mapped-key-for-c-address');
  });

  it('converts stroops to decimal string before sending', async () => {
    let capturedBody = '';
    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = options?.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          error: [],
          result: { refid: 'REF-DECIMAL-OK' },
        }),
      } as unknown as Response;
    });

    const reqWithFraction: WithdrawalRequest = {
      ...request,
      amount: '15000000', // 1.5 XLM
    };

    await defaultCexHandlers.kraken(reqWithFraction, config);

    const parsedParams = new URLSearchParams(capturedBody);
    expect(parsedParams.get('amount')).toBe('1.5');
  });

  describe('stroopsToDecimal', () => {
    it.each([
      { stroops: '10000000', expected: '1' },
      { stroops: '15000000', expected: '1.5' },
      { stroops: '5000000', expected: '0.5' },
      { stroops: '100', expected: '0.00001' },
      { stroops: '1', expected: '0.0000001' },
      { stroops: '0', expected: '0' },
      { stroops: '12345678901234', expected: '1234567.8901234' },
    ])('converts $stroops stroops -> $expected', ({ stroops, expected }) => {
      expect(stroopsToDecimal(stroops)).toBe(expected);
    });
  });
});
