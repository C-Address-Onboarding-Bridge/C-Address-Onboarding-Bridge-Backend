/**
 * Issue #674: Rewritten SDK funding flow tests against real types.
 * Tests the complete prepare → sign → submit → poll flow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BridgeClient } from '../bridge';
import type { FundingPrepareResult, FundingResult } from '../types';

process.env.NODE_ENV = 'test';

vi.mock('../telemetry', () => ({
  TelemetryClient: vi.fn(() => ({
    record: vi.fn(),
  })),
}));

describe('SDK Funding Flows', () => {
  let client: BridgeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new BridgeClient({
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-key-12345',
    });
  });

  describe('Funding preparation', () => {
    it('prepares a funding request with valid parameters', async () => {
      global.fetch = vi.fn(async (url: string, opts: RequestInit) => {
        if (typeof url === 'string' && url.includes('/api/v1/fund')) {
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

      const result = await client.prepareFunding({
        destinationAddress: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
        sourceAsset: 'native',
        amount: '100',
        offRampProvider: 'moonpay',
      });

      expect(result).toBeDefined();
      expect(result.hash).toBe('mock-transaction-hash-123');
      expect(result.envelope).toBeDefined();
      expect(result.networkPassphrase).toBe('Test SDF Network ; September 2015');
    });

    it('includes idempotency key in prepare requests', async () => {
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
                envelope: 'mock-xdr',
                networkPassphrase: 'Test SDF Network ; September 2015',
                signingKey: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
              } as FundingPrepareResult,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error('Unexpected request');
      });

      await client.prepareFunding(
        {
          destinationAddress: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
          sourceAsset: 'native',
          amount: '100',
          offRampProvider: 'moonpay',
        },
        { idempotencyKey: '12345678-1234-4123-8123-123456789012' }
      );

      // Issue #671: Verify lowercase header name is used
      expect(capturedHeaders['x-idempotency-key']).toBe('12345678-1234-4123-8123-123456789012');
    });
  });

  describe('Transaction submission', () => {
    it('submits a signed transaction and returns funding result', async () => {
      global.fetch = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('/api/v1/fund')) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                hash: 'submitted-tx-hash',
                status: 'pending',
                createdAt: new Date().toISOString(),
              } as FundingResult,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error('Unexpected request');
      });

      const result = await client.submitSignedXdr({
        signedXdr: 'AAAAAgAAAACJL+8TP++pRfI4CRAZhA+mWXG1w3E1HxP+7i+pF+QvAAAB6AHjDCAAACKUAAAAAAAAAAEAAAAAAAAAAQAAAAAAAAAAAAABsrz2mgAAAABj5qn8',
      });

      expect(result).toBeDefined();
      expect(result.hash).toBe('submitted-tx-hash');
      expect(result.status).toBe('pending');
    });
  });

  describe('Signing header support', () => {
    it('includes signing headers when signing is enabled', async () => {
      let capturedHeaders: Record<string, string | undefined> = {};

      const signingClient = new BridgeClient({
        baseUrl: 'http://localhost:3000',
        apiKey: 'signing-key-secret',
        signing: { enabled: true },
      });

      global.fetch = vi.fn(async (url: string, opts: RequestInit) => {
        if (typeof url === 'string' && url.includes('/api/v1/fund')) {
          const headers = opts.headers as Record<string, string>;
          capturedHeaders = {
            'x-timestamp': headers['x-timestamp'],
            'x-nonce': headers['x-nonce'],
            'x-signature': headers['x-signature'],
          };

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

      // Issue #673: Verify signing headers are present
      expect(capturedHeaders['x-timestamp']).toBeDefined();
      expect(capturedHeaders['x-nonce']).toBeDefined();
      expect(capturedHeaders['x-signature']).toBeDefined();
      expect(capturedHeaders['x-signature']).toMatch(/^sha256=/);
    });
  });
});
