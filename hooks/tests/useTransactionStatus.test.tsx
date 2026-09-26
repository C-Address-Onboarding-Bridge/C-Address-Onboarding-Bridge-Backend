import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useTransactionStatus } from '../src';

const BASE_URL = 'http://localhost:3001';

describe('useTransactionStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fetches transaction status', async () => {
    const mockStatus = { status: 'success', hash: 'abc123' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockStatus) }),
    );

    const { result } = renderHook(() => useTransactionStatus({ baseUrl: BASE_URL }, 'abc123'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(mockStatus);
    expect(result.current.error).toBeUndefined();
  });

  it('does not fetch when txHash is undefined', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useTransactionStatus({ baseUrl: BASE_URL }, undefined));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('polls while pending and stops once the status is terminal', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'pending', hash: 'abc123' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'success', hash: 'abc123' }) });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useTransactionStatus(
        { baseUrl: BASE_URL, cache: { statusTtlMs: 0, staleWhileRevalidate: false } },
        'abc123',
        { pollIntervalMs: 10 },
      ),
    );

    await waitFor(() => expect(result.current.data?.status).toBe('success'));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces errors from the bridge client', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ message: 'boom' }),
      }),
    );

    const { result } = renderHook(() =>
      useTransactionStatus({ baseUrl: BASE_URL, retry: { maxRetries: 0 } }, 'abc123'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('resets data and error when txHash changes', async () => {
    const mockStatus1 = { status: 'pending', hash: 'hash1' };
    const mockStatus2 = { status: 'success', hash: 'hash2' };
    let resolveSecondStatus: (val?: any) => void;
    const secondPromise = new Promise((resolve) => {
      resolveSecondStatus = resolve;
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockStatus1) })
      .mockReturnValueOnce(secondPromise);
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(
      (props: { txHash: string | undefined }) =>
        useTransactionStatus(
          { baseUrl: BASE_URL, cache: { statusTtlMs: 0, staleWhileRevalidate: false } },
          props.txHash,
        ),
      { initialProps: { txHash: 'hash1' } },
    );

    await waitFor(() => expect(result.current.data).toEqual(mockStatus1));

    rerender({ txHash: 'hash2' });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeUndefined();

    resolveSecondStatus!({ ok: true, json: () => Promise.resolve(mockStatus2) });
    await waitFor(() => expect(result.current.data).toEqual(mockStatus2));
  });

  it('continues polling with backoff after errors until terminal status', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'pending', hash: 'hash1' }) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({ message: 'temporary server error' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'success', hash: 'hash1' }) });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useTransactionStatus(
        { baseUrl: BASE_URL, retry: { maxRetries: 0 }, cache: { statusTtlMs: 0, staleWhileRevalidate: false } },
        'hash1',
        { pollIntervalMs: 20 },
      ),
    );

    await waitFor(() => expect(result.current.data?.status).toBe('pending'));

    // Wait for the transient error
    await waitFor(() => expect(result.current.error).toBeDefined());

    // Should continue polling after the error and recover to success
    await waitFor(() => expect(result.current.data?.status).toBe('success'), { timeout: 2000 });
    expect(result.current.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
