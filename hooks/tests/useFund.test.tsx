import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useFund } from '../src';
import { createMockServer, fixtures, MOCK_FUND_PARAMS } from '../../sdk/src/testing';

const CONFIG = {
  baseUrl: 'http://localhost:3001',
  retry: { maxRetries: 0 },
  cache: { statusTtlMs: 0, staleWhileRevalidate: false },
};
// Testnet native XLM SAC: the SDK validates the token address before preparing.
const FUND_PARAMS = { ...MOCK_FUND_PARAMS, tokenAddress: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC' };
const server = createMockServer();

function fundRequests() {
  return server.requests.filter((r) => r.method === 'POST' && r.pathname === '/api/v1/fund');
}

describe('useFund', () => {
  beforeEach(() => {
    server.reset().install();
  });

  afterEach(() => {
    server.uninstall();
  });

  it('runs prepare → submit → status and follows the transaction to a terminal status', async () => {
    const result = fixtures.fundingResult();
    server.onFund().reply(201, result);
    server.onStatus(result.hash).reply(200, fixtures.transactionStatus('success', { hash: result.hash }));

    const { result: hook } = renderHook(() => useFund(CONFIG, { pollIntervalMs: 10 }));
    expect(hook.current.step).toBe('idle');

    await act(async () => {
      await hook.current.prepare(FUND_PARAMS);
    });
    expect(hook.current.step).toBe('prepared');
    expect(hook.current.prepared).toEqual(fixtures.fundingPrepareResult());

    await act(async () => {
      await hook.current.submit('signed-xdr');
    });
    expect(hook.current.step).toBe('submitted');
    expect(hook.current.result).toEqual(result);
    expect(fundRequests()[0].body).toEqual({ signedXdr: 'signed-xdr' });

    await waitFor(() => expect(hook.current.status?.status).toBe('success'));
  });

  it('sends one idempotency key per attempt and reuses it when resubmitting', async () => {
    const { result: hook } = renderHook(() => useFund(CONFIG));

    await act(async () => {
      await hook.current.prepare(FUND_PARAMS);
    });
    const key = hook.current.idempotencyKey;
    expect(key).toMatch(/^[0-9a-f]{32}$/);

    server.onFund().reply(503, { message: 'unavailable' });
    await act(async () => {
      await expect(hook.current.submit('signed-xdr')).rejects.toThrow();
    });
    const failedKey = fundRequests()[0].headers['x-idempotency-key'];

    server.reset();
    await act(async () => {
      await hook.current.submit('signed-xdr');
    });
    const retriedKey = fundRequests()[0].headers['x-idempotency-key'];

    // Resubmitting the same attempt reuses its key so the server can deduplicate.
    expect(failedKey).toBe(key);
    expect(retriedKey).toBe(key);

    act(() => hook.current.reset());
    await act(async () => {
      await hook.current.prepare(FUND_PARAMS);
    });

    expect(hook.current.idempotencyKey).toBeDefined();
    expect(hook.current.idempotencyKey).not.toBe(key);
  });

  it('exposes submission errors and reset() returns to idle', async () => {
    server.onFund().reply(400, { message: 'bad xdr', code: 'INVALID_XDR' });
    const { result: hook } = renderHook(() => useFund(CONFIG));

    await act(async () => {
      await expect(hook.current.submit('bad')).rejects.toThrow();
    });
    expect(hook.current.step).toBe('error');
    expect(hook.current.error).toBeInstanceOf(Error);

    act(() => hook.current.reset());

    expect(hook.current.step).toBe('idle');
    expect(hook.current.error).toBeUndefined();
    expect(hook.current.result).toBeUndefined();
    expect(hook.current.idempotencyKey).toBeUndefined();
  });
});
