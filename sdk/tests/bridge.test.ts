import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BridgeClient } from '../src/bridge';
import { PaginatedResponse } from '../src/types';
import { calculateFee, calculateReceiveAmount, isValidStellarAddress, isCAddress, isGAddress } from '../src/utils';

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
});
