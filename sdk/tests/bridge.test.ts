import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BridgeClient } from '../src/bridge';
import { PaginatedResponse, Token } from '../src/types';
import {
  calculateFee,
  calculateReceiveAmount,
  isValidStellarAddress,
  isCAddress,
  isGAddress,
  isSacTokenAddress,
  validateSacTokenAddress,
  formatTokenAmount,
  parseTokenAmount,
  tokenToSourceAsset,
  tokenFromLegacy,
  getDefaultDecimals,
} from '../src/utils';

const VALID_C_ADDR = 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
const VALID_G_ADDR = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';

describe('BridgeClient', () => {
  it('creates a client with base url', () => {
    const client = new BridgeClient({ baseUrl: 'http://localhost:3001' });
    expect(client).toBeInstanceOf(BridgeClient);
  });

  it('normalizes trailing slash in base url', () => {
    const client = new BridgeClient({ baseUrl: 'http://localhost:3001/' });
    expect(client).toBeInstanceOf(BridgeClient);
  });

  it('creates a client with api key', () => {
    const client = new BridgeClient({ baseUrl: 'http://localhost:3001', apiKey: 'test-key' });
    expect(client).toBeInstanceOf(BridgeClient);
  });

  it('fetches token metadata for a SAC token', async () => {
    const client = new BridgeClient({ baseUrl: 'http://localhost:3001' });
    const mockMeta = {
      decimals: 6,
      name: 'USD Coin',
      symbol: 'USDC',
      issuer: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU',
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockMeta),
    }));

    const result = await client.getTokenMetadata({ contractId: VALID_C_ADDR });
    expect(result).toEqual(mockMeta);
    const calledUrl: string = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toContain(`/api/v1/token/${VALID_C_ADDR}/metadata`);
  });

  it('returns default metadata for native token', async () => {
    const client = new BridgeClient({ baseUrl: 'http://localhost:3001' });
    const result = await client.getTokenMetadata({ contractId: 'native' });
    expect(result.decimals).toBe(7);
    expect(result.symbol).toBe('XLM');
    expect(result.name).toBe('Stellar Lumens');
  });

  it('getQuote works with SAC token parameter', async () => {
    const client = new BridgeClient({ baseUrl: 'http://localhost:3001' });
    const mockQuote = {
      estimatedFee: '100',
      expectedReceive: '9900',
      feeBps: 100,
      rate: '1.0',
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockQuote),
    }));

    const sacToken: Token = { type: 'sac', contractId: VALID_C_ADDR };
    const result = await client.getQuote({
      sourceAsset: 'USDC',
      amount: '1000000',
      targetAddress: VALID_G_ADDR,
      token: sacToken,
    });

    expect(result).toEqual(mockQuote);
    const calledUrl: string = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toContain(VALID_C_ADDR); // contractId passed as sourceAsset
  });

  it('getQuote backward compatible without token param', async () => {
    const client = new BridgeClient({ baseUrl: 'http://localhost:3001' });
    const mockQuote = {
      estimatedFee: '100',
      expectedReceive: '9900',
      feeBps: 100,
      rate: '1.0',
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockQuote),
    }));

    const result = await client.getQuote({
      sourceAsset: 'XLM',
      amount: '10000',
      targetAddress: VALID_G_ADDR,
    });

    expect(result).toEqual(mockQuote);
    const calledUrl: string = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toContain('sourceAsset=XLM');
  });

  it('prepareFundingTransaction with explicit token param', async () => {
    const client = new BridgeClient({ baseUrl: 'http://localhost:3001' });
    const mockPrepare = {
      instruction: 'sign-and-submit',
      simulation: { status: 'success', fee: '100' },
      params: {
        sourceAddress: VALID_G_ADDR,
        targetAddress: VALID_C_ADDR,
        tokenAddress: VALID_C_ADDR,
        amount: '1000000',
        memo: '',
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockPrepare),
    }));

    const sacToken: Token = { type: 'sac', contractId: VALID_C_ADDR };
    const result = await client.prepareFundingTransaction({
      sourceAddress: VALID_G_ADDR,
      targetAddress: VALID_C_ADDR,
      tokenAddress: VALID_C_ADDR,
      amount: '1000000',
      token: sacToken,
    });

    expect(result).toEqual(mockPrepare);
    const calledBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(calledBody.tokenAddress).toBe(VALID_C_ADDR);
  });
});

describe('BridgeClient.requestPaginated', () => {
  let client: BridgeClient;

  beforeEach(() => {
    client = new BridgeClient({ baseUrl: 'http://localhost:3001', apiKey: 'test-key' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches a paginated response with cursor and limit', async () => {
    const mockPage: PaginatedResponse<{ id: string }> = {
      data: [{ id: 'a' }, { id: 'b' }],
      nextCursor: 'cursor-2',
      hasMore: true,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockPage),
    }));

    const result = await client.requestPaginated<{ id: string }>('/api/v1/txns', {
      limit: 2,
      cursor: 'cursor-1',
    });

    expect(result).toEqual(mockPage);
    const calledUrl: string = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toContain('limit=2');
    expect(calledUrl).toContain('cursor=cursor-1');
  });

  it('handles the last page with hasMore false and no nextCursor', async () => {
    const mockPage: PaginatedResponse<{ id: string }> = {
      data: [{ id: 'z' }],
      nextCursor: null,
      hasMore: false,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockPage),
    }));

    const result = await client.requestPaginated<{ id: string }>('/api/v1/txns', { offset: 10, limit: 5 });

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    const calledUrl: string = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toContain('offset=10');
    expect(calledUrl).toContain('limit=5');
  });
});

describe('Utils', () => {
  it('calculates fee correctly', () => {
    expect(calculateFee(1000n, 100)).toBe(10n);
    expect(calculateFee(1000n, 0)).toBe(0n);
    expect(calculateFee(10000n, 50)).toBe(50n);
  });

  it('calculates receive amount correctly', () => {
    expect(calculateReceiveAmount(1000n, 100)).toBe(990n);
    expect(calculateReceiveAmount(1000n, 0)).toBe(1000n);
  });

  it('validates stellar addresses', () => {
    expect(isValidStellarAddress(VALID_C_ADDR)).toBe(true);
    expect(isValidStellarAddress(VALID_G_ADDR)).toBe(true);
    expect(isValidStellarAddress('not-an-address')).toBe(false);
    expect(isValidStellarAddress('')).toBe(false);
    expect(isValidStellarAddress('G7QJ2X2L7U')).toBe(false);
  });

  it('distinguishes C vs G addresses', () => {
    expect(isCAddress(VALID_C_ADDR)).toBe(true);
    expect(isCAddress(VALID_G_ADDR)).toBe(false);
    expect(isGAddress(VALID_G_ADDR)).toBe(true);
    expect(isGAddress(VALID_C_ADDR)).toBe(false);
  });

  it('validates SAC token addresses', () => {
    expect(isSacTokenAddress(VALID_C_ADDR)).toBe(true);
    expect(isSacTokenAddress(VALID_G_ADDR)).toBe(false);
    expect(isSacTokenAddress('not-an-address')).toBe(false);
    expect(() => validateSacTokenAddress('invalid')).toThrow();
    expect(() => validateSacTokenAddress(VALID_C_ADDR)).not.toThrow();
  });

  it('formats token amounts with different decimals', () => {
    expect(formatTokenAmount('1000000', 6)).toBe('1.000000');
    expect(formatTokenAmount('10000000', 7)).toBe('1.0000000');
    expect(formatTokenAmount('500', 6)).toBe('0.000500');
    expect(formatTokenAmount('0', 6)).toBe('0.000000');
  });

  it('parses token amounts with different decimals', () => {
    expect(parseTokenAmount('1.5', 6)).toBe('1500000');
    expect(parseTokenAmount('1.5', 7)).toBe('15000000');
    expect(parseTokenAmount('0.001', 6)).toBe('1000');
    expect(parseTokenAmount('2', 6)).toBe('2000000');
  });

  it('converts token to source asset string', () => {
    expect(tokenToSourceAsset({ type: 'native' })).toBe('XLM');
    expect(tokenToSourceAsset({ type: 'sac', contractId: VALID_C_ADDR })).toBe(VALID_C_ADDR);
  });

  it('derives token from legacy parameters', () => {
    expect(tokenFromLegacy(VALID_C_ADDR)).toEqual({ type: 'sac', contractId: VALID_C_ADDR });
    expect(tokenFromLegacy(undefined, 'XLM')).toEqual({ type: 'native' });
    expect(tokenFromLegacy(undefined, VALID_C_ADDR)).toEqual({ type: 'sac', contractId: VALID_C_ADDR });
    expect(tokenFromLegacy()).toEqual({ type: 'native' });
  });

  it('returns correct default decimals', () => {
    expect(getDefaultDecimals({ type: 'native' })).toBe(7);
    expect(getDefaultDecimals({ type: 'sac', contractId: VALID_C_ADDR })).toBe(6);
  });
});

describe('BridgeClient.getTokenMetadata URL encoding', () => {
  it('encodes special characters in contractId', async () => {
    const client = new BridgeClient({ baseUrl: 'http://localhost:3001' });
    const mockMeta = { decimals: 6, name: 'Test', symbol: 'TST' };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockMeta),
    }));

    const contractIdWithSpecialChars = 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567+%20#';
    await client.getTokenMetadata({ contractId: contractIdWithSpecialChars });

    const calledUrl: string = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toContain('/api/v1/token/');
    expect(calledUrl).not.toContain('+%20#');
    const url = new URL(calledUrl);
    expect(url.pathname).toBe(`/api/v1/token/${encodeURIComponent(contractIdWithSpecialChars)}/metadata`);
  });

  it('rejects invalid contractId format', async () => {
    const client = new BridgeClient({ baseUrl: 'http://localhost:3001' });
    await expect(client.getTokenMetadata({ contractId: 'invalid' })).rejects.toThrow();
  });
});

describe('BridgeClient.getStatus URL encoding', () => {
  it('encodes special characters in txHash', async () => {
    const client = new BridgeClient({ baseUrl: 'http://localhost:3001' });
    const mockStatus = { status: 'success' as const, txHash: 'abc+def#123' };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockStatus),
    }));

    const txHash = 'abc+def#123';
    await client.getStatus(txHash);

    const calledUrl: string = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toContain('/api/v1/status/');
    expect(calledUrl).not.toContain('+#');
    const url = new URL(calledUrl);
    expect(url.pathname).toBe(`/api/v1/status/${encodeURIComponent(txHash)}`);
  });

  it('rejects empty txHash', async () => {
    const client = new BridgeClient({ baseUrl: 'http://localhost:3001' });
    await expect(client.getStatus('')).rejects.toThrow();
    await expect(client.getStatus('   ')).rejects.toThrow();
  });
});

describe('BridgeClient stale-while-revalidate', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns a stale quote immediately and refreshes it in the background', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const client = new BridgeClient({
      baseUrl: 'http://localhost:3001',
      cache: { quoteTtlMs: 10 },
    });
    const staleQuote = { estimatedFee: '100', expectedReceive: '9900', feeBps: 100, rate: '1.0' };
    const freshQuote = { estimatedFee: '200', expectedReceive: '9800', feeBps: 200, rate: '1.0' };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(staleQuote) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(freshQuote) });
    vi.stubGlobal('fetch', fetchMock);

    const params = { sourceAsset: 'XLM', amount: '10000', targetAddress: VALID_G_ADDR };

    const first = await client.getQuote(params);
    expect(first).toEqual(staleQuote);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance past the 10ms TTL but within the (default) 2x stale-while-revalidate window.
    vi.setSystemTime(15);

    const second = await client.getQuote(params);
    expect(second).toEqual(staleQuote); // stale value served immediately, no request awaited
    expect(fetchMock).toHaveBeenCalledTimes(2); // but a background refresh was triggered

    // Flush the background refresh's promise chain (cache.set happens in a .then()).
    await vi.advanceTimersByTimeAsync(0);

    const third = await client.getQuote(params);
    expect(third).toEqual(freshQuote); // cache now holds the refreshed value
    expect(fetchMock).toHaveBeenCalledTimes(2); // served from cache, no new request
  });

  it('does not trigger a background refresh for a fresh cache hit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const client = new BridgeClient({
      baseUrl: 'http://localhost:3001',
      cache: { statusTtlMs: 10_000 },
    });
    const mockStatus = { status: 'pending' as const, hash: 'abc123' };

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockStatus),
    });
    vi.stubGlobal('fetch', fetchMock);

    await client.getStatus('abc123');
    vi.setSystemTime(1000); // well within the 10s TTL
    const second = await client.getStatus('abc123');

    expect(second).toEqual(mockStatus);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('BridgeClient.runDiagnostics', () => {
  let client: BridgeClient;

  beforeEach(() => {
    client = new BridgeClient({ baseUrl: 'http://localhost:3001', apiKey: 'test-key' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns healthy when all checks pass', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'ok' }) }) // health
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'ok' }) }) // health latency
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ estimatedFee: '100', expectedReceive: '9900', feeBps: 100, rate: '1.0' }) }) // quote
    );

    const result = await client.runDiagnostics();
    expect(result.status).toBe('healthy');
    expect(result.checks.apiKey?.status).toBe('pass');
    expect(result.checks.connectivity?.status).toBe('pass');
    expect(result.checks.contractStatus?.status).toBe('pass');
    expect(result.timestamp).toBeTruthy();
  });

  it('returns unhealthy when API key check fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({ message: 'Unauthorized' }) }));

    const result = await client.runDiagnostics({ checkApiKey: true, checkConnectivity: false, checkContractStatus: false });
    expect(result.status).toBe('unhealthy');
    expect(result.checks.apiKey?.status).toBe('fail');
    expect(result.checks.apiKey?.message).toContain('Unauthorized');
  });

  it('returns unhealthy when connectivity check fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({ message: 'Server error' }) }));

    const result = await client.runDiagnostics({ checkApiKey: false, checkConnectivity: true, checkContractStatus: false });
    expect(result.status).toBe('unhealthy');
    expect(result.checks.connectivity?.status).toBe('fail');
  });

  it('returns unhealthy when contract status check fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'ok' }) }) // health
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'ok' }) }) // health latency
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({ message: 'Contract error' }) }) // quote
    );

    const result = await client.runDiagnostics({ checkApiKey: false, checkConnectivity: false, checkContractStatus: true });
    expect(result.status).toBe('unhealthy');
    expect(result.checks.contractStatus?.status).toBe('fail');
  });

  it('validates address when targetAddress is provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'ok' }) }));

    const result = await client.runDiagnostics({
      checkApiKey: false,
      checkConnectivity: false,
      checkContractStatus: false,
      targetAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
    });
    expect(result.checks.addressValidation?.status).toBe('pass');
    expect(result.checks.addressValidation?.addressType).toBe('C-address');
  });

  it('fails address validation for invalid address', async () => {
    const result = await client.runDiagnostics({
      checkApiKey: false,
      checkConnectivity: false,
      checkContractStatus: false,
      targetAddress: 'invalid-address',
    });
    expect(result.status).toBe('unhealthy');
    expect(result.checks.addressValidation?.status).toBe('fail');
    expect(result.checks.addressValidation?.message).toContain('Invalid Stellar address format');
  });

  it('skips checks when explicitly disabled', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const result = await client.runDiagnostics({
      checkApiKey: false,
      checkConnectivity: false,
      checkContractStatus: false,
    });
    expect(result.status).toBe('healthy');
    expect(result.checks).toEqual({});
  });
});

