import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BridgeClient } from '../src/bridge';
import { ServerError, ValidationError, isServerError } from '../src/errors';

const VALID_G_ADDR = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';

const BASE_CONFIG = {
  baseUrl: 'http://localhost:3001',
  retry: {
    maxRetries: 3,
    baseDelayMs: 10,
    maxDelayMs: 50,
    retryBudgetMs: 5_000,
    jitterMs: 0,
    // Silence retry logging during tests.
    logger: { debug: () => {} } as unknown as Pick<Console, 'debug'>,
  },
};

function quoteCall(client: BridgeClient) {
  return client.getQuote({
    sourceAsset: 'XLM',
    amount: '10000',
    targetAddress: VALID_G_ADDR,
  });
}

/** Minimal successful Response stand-in for fetch mocks. */
function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  };
}

describe('BridgeClient retry classification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not retry a JSON parse failure on a successful response', async () => {
    const client = new BridgeClient(BASE_CONFIG);

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = quoteCall(client);
    // If retries were attempted, their setTimeout delays would fire here.
    await vi.runAllTimersAsync();

    const err = await pending.then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ServerError);
    expect(isServerError(err)).toBe(true);
    expect((err as ServerError).retryable).toBe(false);
    expect((err as ServerError).cause).toBeInstanceOf(SyntaxError);
    expect((err as ServerError).message).toContain('non-JSON response');

    // The regression: the old code called fetch 4 times (1 + 3 retries).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a raw TypeError from fetch and eventually succeeds', async () => {
    const client = new BridgeClient(BASE_CONFIG);
    const quote = { estimatedFee: '1', expectedReceive: '9999', feeBps: 1, rate: '1.0' };

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okJson(quote));
    vi.stubGlobal('fetch', fetchMock);

    const pending = quoteCall(client);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual(quote);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable 4xx BridgeError', async () => {
    const client = new BridgeClient(BASE_CONFIG);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ message: 'bad input', code: 'BAD_INPUT' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = quoteCall(client);
    await vi.runAllTimersAsync();

    await expect(pending).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx ServerError and eventually succeeds', async () => {
    const client = new BridgeClient(BASE_CONFIG);
    const quote = { estimatedFee: '1', expectedReceive: '9999', feeBps: 1, rate: '1.0' };

    const serverErrorResponse = {
      ok: false,
      status: 500,
      json: () => Promise.resolve({ message: 'oops' }),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(serverErrorResponse)
      .mockResolvedValueOnce(serverErrorResponse)
      .mockResolvedValueOnce(serverErrorResponse)
      .mockResolvedValueOnce(okJson(quote));
    vi.stubGlobal('fetch', fetchMock);

    const pending = quoteCall(client);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual(quote);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry an AbortError', async () => {
    const client = new BridgeClient(BASE_CONFIG);

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    vi.stubGlobal('fetch', fetchMock);

    const pending = quoteCall(client);
    await vi.runAllTimersAsync();

    // The catch-path re-wraps abort as TimeoutError; the key assertion is that
    // no retry occurred.
    await expect(pending).rejects.toThrow(/timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
