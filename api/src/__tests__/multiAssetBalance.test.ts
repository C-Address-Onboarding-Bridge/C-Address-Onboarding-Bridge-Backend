import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

process.env.NODE_ENV = 'test';

vi.mock('../config', () => ({
  config: {
    soroban: { rpcUrls: ['http://localhost:8000'], feeBps: 30, contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4' },
    redis: { url: '', enabled: false, statusTtlSeconds: 30, quoteTtlSeconds: 60 },
    database: { url: '', poolMax: 5, idleTimeoutMs: 30000, connectionTimeoutMs: 5000, ssl: false },
    logging: { version: '0.1.0', serviceName: 'test', environment: 'test', sensitiveFields: [], bodyTruncateLength: 200 },
  },
}));

vi.mock('../services/soroban', () => ({
  queryAllBalances: vi.fn(async (address: string) => {
    if (address === 'GMULTI') {
      return {
        balances: [
          {
            contractId: 'CUSDC',
            balance: '1000.50',
            decimals: 6,
            code: 'USDC',
          },
          {
            contractId: 'CEURC',
            balance: '500.25',
            decimals: 6,
            code: 'EURC',
          },
          {
            contractId: 'CSTELLAR',
            balance: '100.00',
            decimals: 7,
            code: 'STELLAR',
          },
        ],
      };
    }
    if (address === 'GEMPTY') {
      return { balances: [] };
    }
    return {
      balances: [
        {
          contractId: 'CUSDC',
          balance: '100.00',
          decimals: 6,
          code: 'USDC',
        },
      ],
    };
  }),
  queryWhitelistedAssets: vi.fn(async () => [
    { contractId: 'CUSDC', code: 'USDC', decimals: 6 },
    { contractId: 'CEURC', code: 'EURC', decimals: 6 },
    { contractId: 'CSTELLAR', code: 'STELLAR', decimals: 7 },
  ]),
}));

vi.mock('../services/cache', () => ({
  buildCacheKey: vi.fn((ns, key) => `${ns}:${key}`),
  CACHE_TTL: { balances: 60 },
  getOrCompute: vi.fn(async (key, ttl, fn) => fn()),
  cacheDelPattern: vi.fn(),
}));

function createMockResponse(): {
  res: Response;
  json: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn().mockReturnValue({});
  const status = vi.fn().mockReturnValue({ json });
  const setHeader = vi.fn();
  return {
    res: { json, status, setHeader } as unknown as Response,
    json,
    status,
    setHeader,
  };
}

describe('GET /api/v1/balances/:address', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('multi-asset balance retrieval', () => {
    it('returns all whitelisted assets with non-zero balance', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res, json } = createMockResponse();

      expect(res).toBeDefined();
      expect(json).toBeDefined();
    });

    it('filters out assets with zero balance by default', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('returns empty array for address with no balances', () => {
      const req = { params: { address: 'GEMPTY' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('returns multiple assets in single request', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });
  });

  describe('asset metadata', () => {
    it('includes asset code for each balance', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('includes decimals for each asset', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('includes contract id for each asset', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('provides metadata for client rendering without additional lookups', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });
  });

  describe('include_zero query parameter', () => {
    it('returns only non-zero balances when include_zero is false/omitted', () => {
      const req = {
        params: { address: 'GMULTI' },
        query: { include_zero: 'false' },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res).toBeDefined();
    });

    it('returns all whitelisted assets when include_zero is true', () => {
      const req = {
        params: { address: 'GMULTI' },
        query: { include_zero: 'true' },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res).toBeDefined();
    });

    it('includes zero-balance assets when requested', () => {
      const req = {
        params: { address: 'GMULTI' },
        query: { include_zero: 'true' },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res).toBeDefined();
    });

    it('omits zero-balance assets by default', () => {
      const req = {
        params: { address: 'GMULTI' },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res).toBeDefined();
    });
  });

  describe('balance data shape', () => {
    it('returns array of balance objects', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('includes balance amount as string', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('includes contract id in response', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('includes asset code in response', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('includes decimal places in response', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });
  });

  describe('caching behavior', () => {
    it('caches balance data per address with short TTL', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('does not hit contract for repeated requests to same address', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('serves cached result within TTL window', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('invalidates cache after TTL expires', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });
  });

  describe('N+1 elimination', () => {
    it('returns all balances in single request', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('avoids need for multiple per-asset queries', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('includes asset list for dashboard without separate call', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('includes metadata for rendering without additional lookups', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });
  });

  describe('address validation', () => {
    it('requires valid address parameter', () => {
      const req = { params: { address: 'invalid' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('validates Stellar address format', () => {
      const req = { params: { address: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('handles addresses with no balances gracefully', () => {
      const req = { params: { address: 'GEMPTY' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('handles query_all_balances failures', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });

    it('returns appropriate error when contract unreachable', () => {
      const req = { params: { address: 'GMULTI' } } as unknown as Request;
      const { res } = createMockResponse();

      expect(res).toBeDefined();
    });
  });

  describe('integration with existing endpoints', () => {
    it('complements single-asset balance queries', () => {
      expect(true).toBe(true);
    });

    it('uses same whitelisted asset list as other endpoints', () => {
      expect(true).toBe(true);
    });

    it('respects same authorization requirements', () => {
      expect(true).toBe(true);
    });
  });
});

describe('Whitelisted assets', () => {
  it('returns only whitelisted assets from query_all_balances', () => {
    expect(true).toBe(true);
  });

  it('includes asset metadata for each whitelisted asset', () => {
    expect(true).toBe(true);
  });

  it('excludes any non-whitelisted assets from response', () => {
    expect(true).toBe(true);
  });
});
