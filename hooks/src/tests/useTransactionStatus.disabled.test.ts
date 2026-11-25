import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTransactionStatus } from '../useTransactionStatus.js';

vi.mock('../useCAddressBridge.js', () => ({
  useCAddressBridge: () => ({
    getStatus: () => new Promise(() => {}), // never resolves
  }),
}));

const config = { baseUrl: 'http://mock' };

describe('useTransactionStatus loading reset', () => {
  it('resets loading to false when enabled flips to false before fetch settles', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useTransactionStatus(config, 'abc123', { enabled }),
      { initialProps: { enabled: true } },
    );

    expect(result.current.loading).toBe(true);

    act(() => {
      rerender({ enabled: false });
    });

    expect(result.current.loading).toBe(false);
  });
});
