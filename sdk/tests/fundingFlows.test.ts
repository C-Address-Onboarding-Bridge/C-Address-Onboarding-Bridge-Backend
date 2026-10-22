/**
 * Issue #674 / #867: SDK funding flow tests against real types.
 * Tests the complete prepare → sign → submit flow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BridgeClient } from '../src/bridge';
import type { FundingPrepareResult, FundingResult } from '../src/types';

process.env.NODE_ENV = 'test';

vi.mock('../src/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: { record: ReturnType<typeof vi.fn> }) {
    this.record = vi.fn();
  }),
}));

describe('SDK Funding Flows', () => {
  let client: BridgeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new BridgeClient({
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-key-12345',
      retry: { maxRetries: 0 },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('Funding preparation', () => {
    it('prepares a funding request with valid parameters', async () => {
      global.fetch = vi.fn(async (url: string, opts: RequestInit) => {
        if (typeof url === 'string' && url.includes('/api/v1/fund/prepare')) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                hash: 'mock-transaction-hash-123',
                envelope: 'mock-xdr-envelope',
                networkPassphrase: 'Test SDF Network ; September 2015',
                signingKey: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
              } as FundingPrepareResult,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error('Unexpected request');
      });

      const result = await client.prepareFundingTransaction({
        sourceAddress: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
        targetAddress: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
        tokenAddress: 'native',
        amount: '100',
      });

      expect(result.instruction).toBe(prepareResult.instruction);
      expect(result.simulation).toEqual({ minResourceFee: '100' });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/v1/fund/prepare');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toMatchObject({
        sourceAddress: TARGET,
        targetAddress: TARGET,
        tokenAddress: 'native',
        amount: '100',
      });
    });
  });

  describe('Transaction submission', () => {
    it('submits a signed transaction and returns the funding result', async () => {
      const fundingResult: FundingResult = { hash: 'submitted-tx-hash', status: 'pending' };
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(fundingResult));
      vi.stubGlobal('fetch', fetchMock);

      const result = await client.submitSignedXdr({ signedXdr: VALID_XDR });

      expect(result.hash).toBe('submitted-tx-hash');
      expect(result.status).toBe('pending');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/v1/fund');
      expect(JSON.parse(String(init.body))).toEqual({ signedXdr: VALID_XDR });
    });

    it('sends an idempotency key for the non-idempotent fund submission', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ hash: 'h1', status: 'pending' }));
      vi.stubGlobal('fetch', fetchMock);

      await client.submitSignedXdr({ signedXdr: VALID_XDR });

      const headers = headersOf(fetchMock.mock.calls[0] as [string, RequestInit]);
      // Issue #671: the lowercase header name is what the API middleware reads.
      expect(headers['x-idempotency-key']).toBeTruthy();
      expect(headers['x-idempotency-key']).toMatch(/^[0-9a-f-]{16,}$/i);
    });

    it('reuses the same idempotency key when the submission is retried', async () => {
      const retrying = new BridgeClient({
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-key-12345',
        retry: { maxRetries: 1, baseDelayMs: 0, jitterMs: 0 },
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ message: 'Service Unavailable' }, 503))
        .mockResolvedValueOnce(jsonResponse({ hash: 'h2', status: 'pending' }));
      vi.stubGlobal('fetch', fetchMock);

      await retrying.submitSignedXdr({ signedXdr: VALID_XDR });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const first = headersOf(fetchMock.mock.calls[0] as [string, RequestInit]);
      const second = headersOf(fetchMock.mock.calls[1] as [string, RequestInit]);
      expect(first['x-idempotency-key']).toBeTruthy();
      expect(first['x-idempotency-key']).toBe(second['x-idempotency-key']);
    });

    it('includes idempotency key in submit requests', async () => {
      let capturedHeaders: Record<string, string> = {};

      global.fetch = vi.fn(async (url: string, opts: RequestInit) => {
        if (typeof url === 'string' && url.includes('/api/v1/fund')) {
          const headers = opts.headers as Record<string, string>;
          capturedHeaders = Object.fromEntries(
            Object.entries(headers).filter(([k]) => typeof k === 'string')
          ) as Record<string, string>;

          return new Response(
            JSON.stringify({
              success: true,
              data: {
                hash: 'mock-tx',
                status: 'pending',
                createdAt: new Date().toISOString(),
              } as FundingResult,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error('Unexpected request');
      });

      await client.submitSignedXdr(
        {
          signedXdr: 'AAAAAgAAAACJL+8TP++pRfI4CRAZhA+mWXG1w3E1HxP+7i+pF+QvAAAB6AHjDCAAACKUAAAAAAAAAAEAAAAAAAAAAQAAAAAAAAAAAAABsrz2mgAAAABj5qn8',
        },
        { idempotencyKey: '12345678-1234-4123-8123-123456789012' }
      );

      expect(capturedHeaders['x-idempotency-key']).toBe('12345678-1234-4123-8123-123456789012');
    });
  });

  describe('Signing header support', () => {
    it('includes signing headers when signing is enabled', async () => {
      const signingClient = new BridgeClient({
        baseUrl: 'http://localhost:3000',
        apiKey: 'signing-key-secret',
        signing: { enabled: true },
        retry: { maxRetries: 0 },
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ hash: 'signed-tx', status: 'pending' }));
      vi.stubGlobal('fetch', fetchMock);

      await signingClient.submitSignedXdr({ signedXdr: VALID_XDR });

          return new Response(
            JSON.stringify({
              success: true,
              data: {
                hash: 'signed-tx',
                status: 'pending',
                createdAt: new Date().toISOString(),
              } as FundingResult,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error('Unexpected request');
      });

      await signingClient.submitSignedXdr({
        signedXdr: 'AAAAAgAAAACJL+8TP++pRfI4CRAZhA+mWXG1w3E1HxP+7i+pF+QvAAAB6AHjDCAAACKUAAAAAAAAAAEAAAAAAAAAAQAAAAAAAAAAAAABsrz2mgAAAABj5qn8',
      });

      expect(capturedHeaders['x-timestamp']).toBeDefined();
      expect(capturedHeaders['x-nonce']).toBeDefined();
      expect(capturedHeaders['x-signature']).toBeDefined();
      expect(capturedHeaders['x-signature']).toMatch(/^sha256=/);
    });
  });
});
