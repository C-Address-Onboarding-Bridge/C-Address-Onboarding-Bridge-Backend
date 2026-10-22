import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../bridge';

describe('Bridge signing retries', () => {
  const signingSecret = 'test-secret';

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('regenerates X-Nonce on each retry attempt', async () => {
    const nonces: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      nonces.push(headers['X-Nonce']);
      if (nonces.length === 1) {
        return new Response(JSON.stringify({ error: 'unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const bridge = new Bridge({
      baseUrl: 'https://example.test',
      signingSecret,
      maxRetries: 3,
      baseDelayMs: 1,
    });

    const promise = bridge.request<{ ok: boolean }>('/v1/transfer', { amount: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toBeTruthy();
    expect(nonces[1]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);
  });
});
