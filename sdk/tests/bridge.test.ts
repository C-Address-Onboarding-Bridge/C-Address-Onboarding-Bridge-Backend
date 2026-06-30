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

