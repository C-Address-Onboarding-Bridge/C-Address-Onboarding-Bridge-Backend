import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import axios from 'axios';
import { BridgeClient } from '../bridge';

const SECRET = 'test-signing-secret';

/**
 * Recompute the HMAC exactly as the API's requestSigningMiddleware does:
 *   METHOD.PATH.SORTED_QUERY.BODY.TIMESTAMP.NONCE
 */
function expectedSignature(
  method: string,
  path: string,
  query: Record<string, unknown> | undefined,
  bodyStr: string,
  timestamp: string,
  nonce: string
): string {
  const sortedQuery = query
    ? Object.keys(query)
        .sort()
        .filter((k) => query[k] !== undefined && query[k] !== null)
        .map(
          (k) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(String(query[k]))}`
        )
        .join('&')
    : '';
  const payload = `${method.toUpperCase()}.${path}.${sortedQuery}.${bodyStr}.${timestamp}.${nonce}`;
  return createHmac('sha256', SECRET).update(payload).digest('hex');
}

describe('BridgeClient request signing', () => {
  let client: BridgeClient;
  let requestSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new BridgeClient({
      apiUrl: 'http://localhost:3000',
      signing: { enabled: true, secret: SECRET },
    });
    requestSpy = vi
      .spyOn(axios.Axios.prototype, 'request')
      .mockResolvedValue({ data: {} } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('signs a GET with an empty body and includes method, path and sorted query', async () => {
    await client.getQuote({ amount: '100', targetAddress: 'GABC' });

    const config = requestSpy.mock.calls[0][0] as {
      method: string;
      url: string;
      params: Record<string, unknown>;
      headers: Record<string, string>;
    };

    const { 'X-Signature': sig, 'X-Timestamp': ts, 'X-Nonce': nonce } =
      config.headers;

    const expected = expectedSignature(
      'GET',
      '/quote',
      { amount: '100', targetAddress: 'GABC' },
      '',
      ts,
      nonce
    );

    expect(sig).toBe(expected);
  });

  it('signs a POST with the JSON body string', async () => {
    const body = { amount: '100', targetAddress: 'GABC' };
    await client.request('POST', '/quote', undefined, body);

    const config = requestSpy.mock.calls[0][0] as {
      method: string;
      url: string;
      params: Record<string, unknown> | undefined;
      headers: Record<string, string>;
    };

    const { 'X-Signature': sig, 'X-Timestamp': ts, 'X-Nonce': nonce } =
      config.headers;

    const expected = expectedSignature(
      'POST',
      '/quote',
      undefined,
      JSON.stringify(body),
      ts,
      nonce
    );

    expect(sig).toBe(expected);
  });
});
