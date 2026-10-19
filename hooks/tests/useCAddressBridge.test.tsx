import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { BridgeClient } from '@c-address-bridge/sdk';
import { useCAddressBridge } from '../src';

const BASE_URL = 'http://localhost:3001';

describe('useCAddressBridge', () => {
  it('creates a BridgeClient instance', () => {
    const { result } = renderHook(() => useCAddressBridge({ baseUrl: BASE_URL }));

    expect(result.current).toBeDefined();
    expect(typeof result.current.getQuote).toBe('function');
  });

  it('memoizes the client across re-renders with an equivalent config', () => {
    const { result, rerender } = renderHook(
      (props: { baseUrl: string }) => useCAddressBridge(props),
      { initialProps: { baseUrl: BASE_URL } },
    );

    const first = result.current;
    rerender({ baseUrl: BASE_URL });

    expect(result.current).toBe(first);
  });

  it('creates a new client when the config changes', () => {
    const { result, rerender } = renderHook(
      (props: { baseUrl: string }) => useCAddressBridge(props),
      { initialProps: { baseUrl: BASE_URL } },
    );

    const first = result.current;
    rerender({ baseUrl: 'http://localhost:3002' });

    expect(result.current).not.toBe(first);
  });

  // #858: a replaced or unmounted client must not keep its telemetry interval
  // running forever (browsers have no `unref()`).
  describe('client lifecycle', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('destroys the previous client when the config changes', () => {
      const destroySpy = vi.spyOn(BridgeClient.prototype, 'destroy');
      const { rerender } = renderHook(
        (props: { baseUrl: string }) => useCAddressBridge(props),
        { initialProps: { baseUrl: BASE_URL } },
      );

      rerender({ baseUrl: 'http://localhost:3002' });

      expect(destroySpy).toHaveBeenCalledTimes(1);
    });

    it('destroys the client on unmount', () => {
      const destroySpy = vi.spyOn(BridgeClient.prototype, 'destroy');
      const { unmount } = renderHook(() => useCAddressBridge({ baseUrl: BASE_URL }));

      unmount();

      expect(destroySpy).toHaveBeenCalledTimes(1);
    });
  });
});
