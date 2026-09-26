import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
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

  it('creates a new client when a function-valued option changes', () => {
    const logger1 = { debug: () => {} };
    const logger2 = { debug: () => {} };

    const { result, rerender } = renderHook(
      (props: { logger: typeof logger1 }) =>
        useCAddressBridge({ baseUrl: BASE_URL, retry: { logger: props.logger } }),
      { initialProps: { logger: logger1 } },
    );

    const first = result.current;
    rerender({ logger: logger2 });

    expect(result.current).not.toBe(first);
  });

  it('does not throw when config contains a BigInt value', () => {
    const configWithBigInt = {
      baseUrl: BASE_URL,
      customValue: 100n,
    } as any;

    expect(() => {
      renderHook(() => useCAddressBridge(configWithBigInt));
    }).not.toThrow();
  });
});
