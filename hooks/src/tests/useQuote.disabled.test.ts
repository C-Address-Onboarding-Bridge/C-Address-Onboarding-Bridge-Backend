import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useQuote } from '../useQuote.js';

vi.mock('../useCAddressBridge.js', () => ({
  useCAddressBridge: () => ({
    getQuote: () => new Promise(() => {}), // never resolves
    invalidateQuoteCache: () => {},
  }),
}));

const config = { baseUrl: 'http://mock' };
const params = { sourceAsset: 'XLM', amount: '1000000', targetAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4' };

describe('useQuote loading reset', () => {
  it('resets loading to false when enabled flips to false before fetch settles', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useQuote(config, params, { enabled }),
      { initialProps: { enabled: true } },
    );

    // loading should be true because fetch is pending
    expect(result.current.loading).toBe(true);

    // flip enabled off
    act(() => {
      rerender({ enabled: false });
    });

    expect(result.current.loading).toBe(false);
  });
});
