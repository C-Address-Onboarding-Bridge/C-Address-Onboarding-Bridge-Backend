import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BridgeEventEmitter } from '../src/events';
import { TransactionStatus } from '../src/types';

/**
 * Helper that produces a `statusFetcher` whose invocations are deferred.
 * Each call returns a new promise whose resolver is pushed onto `pending`.
 * Tests can then resolve fetches explicitly to simulate a slow backend.
 */
function createDeferredFetcher(): {
  fetcher: (txHash: string) => Promise<TransactionStatus>;
  calls: string[];
  pending: Array<(status: TransactionStatus) => void>;
} {
  const calls: string[] = [];
  const pending: Array<(status: TransactionStatus) => void> = [];
  const fetcher = (txHash: string): Promise<TransactionStatus> => {
    calls.push(txHash);
    return new Promise<TransactionStatus>((resolve) => {
      pending.push(resolve);
    });
  };
  return { fetcher, calls, pending };
}

/** Flush the microtask queue so awaiting tick continuations can run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('BridgeEventEmitter.watch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not overlap polls when the status fetcher is slower than the interval', async () => {
    const { fetcher, calls, pending } = createDeferredFetcher();
    const emitter = new BridgeEventEmitter(fetcher, undefined, { pollIntervalMs: 1_000 });

    const successHandler = vi.fn();
    const pendingHandler = vi.fn();
    emitter.on('transaction:success', successHandler);
    emitter.on('transaction:pending', pendingHandler);

    emitter.watch('tx1');

    // With a self-scheduling setTimeout loop, only ONE fetch should ever be
    // in flight, no matter how many intervals elapse while it is unresolved.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);

    // Complete the first fetch with `pending`, then let the loop schedule the
    // next one and fire it.
    pending[0]({ status: 'pending', hash: 'tx1' });
    await flushMicrotasks();
    expect(pendingHandler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2);

    // Resolve the second fetch with `success`. The emitter should emit the
    // success event exactly once and stop scheduling.
    pending[1]({ status: 'success', hash: 'tx1' });
    await flushMicrotasks();
    expect(successHandler).toHaveBeenCalledTimes(1);
    expect(successHandler.mock.calls[0][0].data.txHash).toBe('tx1');

    // Advance time further: no additional fetches should have been scheduled
    // because `unwatch` ran on terminal status.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(2);

    emitter.destroy();
  });

  it('does not emit transaction:success after unwatch is called', async () => {
    const { fetcher, calls, pending } = createDeferredFetcher();
    const emitter = new BridgeEventEmitter(fetcher, undefined, { pollIntervalMs: 1_000 });

    const successHandler = vi.fn();
    emitter.on('transaction:success', successHandler);

    emitter.watch('tx2');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);

    // Cancel the watch while the fetch is still in flight.
    emitter.unwatch('tx2');

    // The in-flight fetch now resolves with a terminal status. It MUST NOT
    // emit `transaction:success` because the watch was cancelled.
    pending[0]({ status: 'success', hash: 'tx2' });
    await flushMicrotasks();

    expect(successHandler).not.toHaveBeenCalled();

    // Ensure no further fetches are scheduled.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);

    emitter.destroy();
  });

  it('does not emit after destroy is called while a fetch is in flight', async () => {
    const { fetcher, calls, pending } = createDeferredFetcher();
    const emitter = new BridgeEventEmitter(fetcher, undefined, { pollIntervalMs: 1_000 });

    const successHandler = vi.fn();
    emitter.on('transaction:success', successHandler);

    emitter.watch('tx3');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);

    emitter.destroy();

    pending[0]({ status: 'success', hash: 'tx3' });
    await flushMicrotasks();

    expect(successHandler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
  });

  it('schedules the next poll only after the previous one settles on error', async () => {
    const calls: string[] = [];
    let invocation = 0;
    const fetcher = (txHash: string): Promise<TransactionStatus> => {
      calls.push(txHash);
      invocation++;
      if (invocation === 1) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({ status: 'success', hash: txHash });
    };

    const emitter = new BridgeEventEmitter(fetcher, undefined, { pollIntervalMs: 1_000 });
    const errorHandler = vi.fn();
    const successHandler = vi.fn();
    emitter.on('error', errorHandler);
    emitter.on('transaction:success', successHandler);

    emitter.watch('tx4');
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);

    // Next poll is scheduled after the failed one; advance time to fire it.
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(calls).toHaveLength(2);
    expect(successHandler).toHaveBeenCalledTimes(1);

    emitter.destroy();
  });
});
