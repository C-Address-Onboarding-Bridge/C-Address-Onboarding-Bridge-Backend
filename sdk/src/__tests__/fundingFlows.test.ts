/**
 * Issue #674: SDK funding flow tests written against the real SDK API and types.
 *
 * Covers prepare → sign → submit, the idempotency key that protects the
 * non-idempotent POST, and the HMAC signing headers added when
 * `signing.enabled` is set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BridgeClient } from '../bridge';
import type { FundingPrepareResult, FundingResult, FundParams } from '../types';

process.env.NODE_ENV = 'test';

const TARGET = 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR';
const VALID_XDR =
  'AAAAAgAAAACJL+8TP++pRfI4CRAZhA+mWXG1w3E1HxP+7i+pF+QvAAAB6AHjDCAAACKUAAAAAAAAAAEAAAAAAAAAAQAAAAAAAAAAAAABsrz2mgAAAABj5qn8';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function headersOf(call: [unknown, RequestInit]): Record<string, string> {
  return (call[1].headers ?? {}) as Record<string, string>;
}

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
    it('prepares a funding request and returns the instruction', async () => {
      const prepareResult: FundingPrepareResult = {
        instruction: 'AAAAAgAAAAB-prepare-instruction',
        simulation: { minResourceFee: '100' },
        params: {
          sourceAddress: TARGET,
          targetAddress: TARGET,
          tokenAddress: 'native',
          amount: '100',
        },
      };
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(prepareResult));
      vi.stubGlobal('fetch', fetchMock);

      const result = await client.prepareFundingTransaction({
        sourceAddress: TARGET,
        targetAddress: TARGET,
        amount: '100',
        tokenAddress: 'native',
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

    it('serializes a SAC token to its contract id when preparing', async () => {
      const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
      const prepareResult: FundingPrepareResult = {
        instruction: 'xdr',
        simulation: {},
        params: { sourceAddress: TARGET, targetAddress: TARGET, tokenAddress: contractId, amount: '100' },
      };
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(prepareResult));
      vi.stubGlobal('fetch', fetchMock);

      await client.prepareFundingTransaction({
        sourceAddress: TARGET,
        targetAddress: TARGET,
        amount: '100',
        tokenAddress: contractId,
        token: { type: 'sac', contractId },
      });

      const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
      expect(body.tokenAddress).toBe(contractId);
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

      // Issue #673: signing headers are present on the outgoing request.
      const headers = headersOf(fetchMock.mock.calls[0] as [string, RequestInit]);
      expect(headers['X-Timestamp']).toBeTruthy();
      expect(headers['X-Nonce']).toHaveLength(32);
      expect(headers['X-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    });
  });
});
