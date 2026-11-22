import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useQuote } from '../src';

const BASE_URL = 'http://localhost:3001';
const QUOTE_PARAMS = { sourceAsset: 'XLM', amount: '10000', targetAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW' };

describe('useQuote', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fetches a quote and reports loading/data state', async () => {
    const mockQuote = { estimatedFee: '100', expectedReceive: '9900', feeBps: 100, rate: '1.0' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockQuote) }),
    );

    const { result } = renderHook(() => useQuote({ baseUrl: BASE_URL }, QUOTE_PARAMS));

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toEqual(mockQuote);
    expect(result.current.error).toBeUndefined();
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
      useQuote({ baseUrl: BASE_URL, retry: { maxRetries: 0 } }, QUOTE_PARAMS),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('does not fetch when disabled', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useQuote({ baseUrl: BASE_URL }, QUOTE_PARAMS, { enabled: false }),
    );

    expect(result.current.loading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch when params are undefined', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useQuote({ baseUrl: BASE_URL }, undefined));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetches when refetch() is called', async () => {
    const mockQuote1 = { estimatedFee: '100', expectedReceive: '9900', feeBps: 100, rate: '1.0' };
    const mockQuote2 = { estimatedFee: '200', expectedReceive: '9800', feeBps: 200, rate: '1.0' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockQuote1) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockQuote2) });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useQuote(
        { baseUrl: BASE_URL, cache: { quoteTtlMs: 0, staleWhileRevalidate: false } },
        QUOTE_PARAMS,
      ),
    );

    await waitFor(() => expect(result.current.data).toEqual(mockQuote1));

    result.current.refetch();

    await waitFor(() => expect(result.current.data).toEqual(mockQuote2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refetch() bypasses the SDK quote cache (#681)', async () => {
    const mockQuote1 = { estimatedFee: '100', expectedReceive: '9900', feeBps: 100, rate: '1.0' };
    const mockQuote2 = { estimatedFee: '200', expectedReceive: '9800', feeBps: 200, rate: '1.0' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockQuote1) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockQuote2) });
    vi.stubGlobal('fetch', fetchMock);

    // Default cache settings: the first quote is still fresh when refetch() runs.
    const { result } = renderHook(() => useQuote({ baseUrl: BASE_URL }, QUOTE_PARAMS));

    await waitFor(() => expect(result.current.data).toEqual(mockQuote1));

    act(() => result.current.refetch());

    await waitFor(() => expect(result.current.data).toEqual(mockQuote2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clears the previous quote as soon as params change (#681)', async () => {
    const mockQuote1 = { estimatedFee: '100', expectedReceive: '9900', feeBps: 100, rate: '1.0' };
    const mockQuote2 = { estimatedFee: '200', expectedReceive: '19800', feeBps: 100, rate: '1.0' };
    let resolveSecond: (value: unknown) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockQuote1) })
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(
      (params: typeof QUOTE_PARAMS) => useQuote({ baseUrl: BASE_URL }, params),
      { initialProps: QUOTE_PARAMS },
    );

    await waitFor(() => expect(result.current.data).toEqual(mockQuote1));

    rerender({ ...QUOTE_PARAMS, amount: '20000' });

    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      resolveSecond({ ok: true, json: () => Promise.resolve(mockQuote2) });
    });

    await waitFor(() => expect(result.current.data).toEqual(mockQuote2));
  });
});
