import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BridgeClient } from '../src/bridge.js';

const BASE_URL = 'http://mock-api';

function mockFetch(response: unknown, status = 200) {
  global.fetch = async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
    }) as Response;
}

describe('BridgeClient.listTransactions', () => {
  it('calls GET /api/v1/transactions with no filters', async () => {
    let capturedUrl = '';
    global.fetch = async (url: string | URL | Request) => {
      capturedUrl = url.toString();
      return { ok: true, status: 200, json: async () => ({ data: [], nextCursor: null, hasMore: false }) } as Response;
    };
    const client = new BridgeClient({ baseUrl: BASE_URL });
    await client.listTransactions();
    expect(capturedUrl).toContain('/api/v1/transactions');
  });

  it('serialises status filter into the query string', async () => {
    let capturedUrl = '';
    global.fetch = async (url: string | URL | Request) => {
      capturedUrl = url.toString();
      return { ok: true, status: 200, json: async () => ({ data: [], nextCursor: null, hasMore: false }) } as Response;
    };
    const client = new BridgeClient({ baseUrl: BASE_URL });
    await client.listTransactions({ status: 'pending' });
    expect(capturedUrl).toContain('status=pending');
  });

  it('serialises fromDate and toDate filters', async () => {
    let capturedUrl = '';
    global.fetch = async (url: string | URL | Request) => {
      capturedUrl = url.toString();
      return { ok: true, status: 200, json: async () => ({ data: [], nextCursor: null, hasMore: false }) } as Response;
    };
    const client = new BridgeClient({ baseUrl: BASE_URL });
    await client.listTransactions({ fromDate: '2024-01-01', toDate: '2024-12-31' });
    expect(capturedUrl).toContain('fromDate=2024-01-01');
    expect(capturedUrl).toContain('toDate=2024-12-31');
  });

  it('serialises cursor pagination params', async () => {
    let capturedUrl = '';
    global.fetch = async (url: string | URL | Request) => {
      capturedUrl = url.toString();
      return { ok: true, status: 200, json: async () => ({ data: [], nextCursor: null, hasMore: false }) } as Response;
    };
    const client = new BridgeClient({ baseUrl: BASE_URL });
    await client.listTransactions({ cursor: 'abc123', limit: 20 });
    expect(capturedUrl).toContain('cursor=abc123');
    expect(capturedUrl).toContain('limit=20');
  });

  it('iterateTransactions returns a PaginationHelper', () => {
    const client = new BridgeClient({ baseUrl: BASE_URL });
    const helper = client.iterateTransactions({ status: 'success' });
    expect(typeof helper.getPage).toBe('function');
    expect(typeof helper.all).toBe('function');
  });
});
