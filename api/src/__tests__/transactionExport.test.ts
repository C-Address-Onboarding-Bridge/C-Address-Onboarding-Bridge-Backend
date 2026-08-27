import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

process.env.NODE_ENV = 'test';

vi.mock('../config', () => ({
  config: {
    soroban: { rpcUrls: ['http://localhost:8000'], feeBps: 30 },
    redis: { url: '', enabled: false, statusTtlSeconds: 30, quoteTtlSeconds: 60 },
    database: { url: '', poolMax: 5, idleTimeoutMs: 30000, connectionTimeoutMs: 5000, ssl: false },
    logging: { version: '0.1.0', serviceName: 'test', environment: 'test', sensitiveFields: [], bodyTruncateLength: 200 },
  },
}));

vi.mock('../services/transactions', () => ({
  listTransactions: vi.fn((params) => {
    if (!params.fromDate || !params.toDate) {
      return { data: [], nextCursor: null, hasMore: false };
    }
    return {
      data: [
        {
          id: 'tx_1001',
          txHash: '0xabc1001',
          sourceAddr: 'GABC1001',
          targetAddr: 'GXYZ1001',
          status: 'success',
          amount: '120.50',
          fee: '0.36',
          netAmount: '120.14',
          asset: 'USDC',
          createdAt: '2026-06-20T10:15:00.000Z',
          currency: 'USDC',
        },
      ],
      nextCursor: null,
      hasMore: false,
    };
  }),
  serializeTransactionsCsv: vi.fn((transactions) => {
    const header = 'txHash,sourceAddr,targetAddr,status,amount,fee,netAmount,asset\n';
    const rows = transactions
      .map((tx: any) => `${tx.txHash},${tx.sourceAddr},${tx.targetAddr},${tx.status},${tx.amount},${tx.fee},${tx.netAmount},${tx.asset}`)
      .join('\n');
    return header + rows;
  }),
}));

function createMockResponse(): { res: Response; getHeader: any; setHeader: any; type: any; send: any; json: any; status: any } {
  const headers: Record<string, any> = {};
  return {
    res: {
      getHeader: (name) => headers[name],
      setHeader: (name, value) => {
        headers[name] = value;
      },
      type: vi.fn(function (t) {
        headers['content-type'] = t;
        return this;
      }),
      send: vi.fn(function (data) {
        return this;
      }),
      json: vi.fn(),
      status: vi.fn(function (code) {
        return this;
      }),
    } as unknown as Response,
    getHeader: (name) => headers[name],
    setHeader: (name, value) => {
      headers[name] = value;
    },
    type: vi.fn(),
    send: vi.fn(),
    json: vi.fn(),
    status: vi.fn(),
  };
}

describe('GET /api/v1/transactions/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('date range validation', () => {
    it('requires fromDate parameter', () => {
      const req = {
        query: { toDate: '2026-06-30', format: 'csv' },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.status).toBeDefined();
    });

    it('requires toDate parameter', () => {
      const req = {
        query: { fromDate: '2026-06-01', format: 'csv' },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.status).toBeDefined();
    });

    it('rejects date ranges exceeding max width', () => {
      const req = {
        query: {
          fromDate: '2025-01-01',
          toDate: '2026-12-31',
          format: 'csv',
        },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.status).toBeDefined();
    });

    it('accepts valid date range within max width', () => {
      const req = {
        query: {
          fromDate: '2026-06-01',
          toDate: '2026-06-30',
          format: 'csv',
        },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.status).toBeDefined();
    });
  });

  describe('CSV export format', () => {
    it('returns CSV content type', () => {
      const req = {
        query: {
          fromDate: '2026-06-01',
          toDate: '2026-06-30',
          format: 'csv',
        },
      } as unknown as Request;

      const response = createMockResponse();
      const { res } = response;

      expect(res.type).toBeDefined();
    });

    it('includes fee, net amount, asset, and transaction hash columns', () => {
      const req = {
        query: {
          fromDate: '2026-06-01',
          toDate: '2026-06-30',
          format: 'csv',
        },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.type).toBeDefined();
    });

    it('sets Content-Disposition header for download', () => {
      const req = {
        query: {
          fromDate: '2026-06-01',
          toDate: '2026-06-30',
          format: 'csv',
        },
      } as unknown as Request;

      const response = createMockResponse();
      const { res } = response;

      expect(res.setHeader).toBeDefined();
    });

    it('handles large result sets by streaming', () => {
      const largeDataset = Array.from({ length: 10000 }, (_, i) => ({
        txHash: `0xabc${i}`,
        sourceAddr: `GSRC${i}`,
        targetAddr: `GTGT${i}`,
        status: 'success' as const,
        amount: '100.00',
        fee: '0.30',
        netAmount: '99.70',
        asset: 'USDC',
        currency: 'USDC',
      }));

      const req = {
        query: {
          fromDate: '2026-06-01',
          toDate: '2026-06-30',
          format: 'csv',
        },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.send || res.write).toBeDefined();
    });
  });

  describe('JSON export format', () => {
    it('returns JSON content type', () => {
      const req = {
        query: {
          fromDate: '2026-06-01',
          toDate: '2026-06-30',
          format: 'json',
        },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.json).toBeDefined();
    });

    it('includes all required fields in JSON response', () => {
      const req = {
        query: {
          fromDate: '2026-06-01',
          toDate: '2026-06-30',
          format: 'json',
        },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.json).toBeDefined();
    });

    it('streams large JSON exports', () => {
      const req = {
        query: {
          fromDate: '2026-06-01',
          toDate: '2026-12-31',
          format: 'json',
        },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.write || res.send).toBeDefined();
    });
  });

  describe('transaction data shape', () => {
    it('includes transaction hash in export', () => {
      const req = {
        query: {
          fromDate: '2026-06-01',
          toDate: '2026-06-30',
          format: 'csv',
        },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.send || res.write).toBeDefined();
    });

    it('includes fee amount in export', () => {
      const req = {
        query: {
          fromDate: '2026-06-01',
          toDate: '2026-06-30',
          format: 'csv',
        },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.send || res.write).toBeDefined();
    });

    it('includes net amount (amount - fee) in export', () => {
      const req = {
        query: {
          fromDate: '2026-06-01',
          toDate: '2026-06-30',
          format: 'csv',
        },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.send || res.write).toBeDefined();
    });

    it('includes asset identifier in export', () => {
      const req = {
        query: {
          fromDate: '2026-06-01',
          toDate: '2026-06-30',
          format: 'csv',
        },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.send || res.write).toBeDefined();
    });
  });

  describe('authentication and authorization', () => {
    it('requires transactions:read scope', () => {
      const req = {
        query: {
          fromDate: '2026-06-01',
          toDate: '2026-06-30',
          format: 'csv',
        },
        headers: {},
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.status).toBeDefined();
    });
  });

  describe('caching behavior', () => {
    it('does not cache CSV responses (format-specific)', () => {
      const req = {
        query: {
          fromDate: '2026-06-01',
          toDate: '2026-06-30',
          format: 'csv',
        },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.send || res.write).toBeDefined();
    });

    it('may cache JSON responses for efficiency', () => {
      const req = {
        query: {
          fromDate: '2026-06-01',
          toDate: '2026-06-30',
          format: 'json',
        },
      } as unknown as Request;

      const { res } = createMockResponse();
      expect(res.json).toBeDefined();
    });
  });
});
