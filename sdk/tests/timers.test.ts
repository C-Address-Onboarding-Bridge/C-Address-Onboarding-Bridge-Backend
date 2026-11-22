/**
 * Issue #858 — SDK timers must be stoppable and must not pin a Node process.
 *
 * Regression coverage:
 *  - `BridgeClient.destroy()` stops the telemetry interval (and flushes first)
 *  - `OfflineBridgeClient.destroy()` stops BOTH its queue poll and telemetry
 *  - `BridgeEventEmitter.destroy()` stops its health interval
 *  - every SDK interval is `unref()`'d when the runtime supports it
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BridgeClient } from '../src/bridge';
import { OfflineBridgeClient, OfflineQueue } from '../src/offline';
import { BridgeEventEmitter } from '../src/events';
import { TelemetryClient } from '../src/telemetry';
import type { TransactionStatus } from '../src/types';

const TELEMETRY_ENDPOINT = 'https://telemetry.example.com';
const BASE_URL = 'http://localhost:3001';

function makeEmitter(): BridgeEventEmitter {
  const statusFetcher = async (): Promise<TransactionStatus> => ({
    status: 'success',
    hash: 'abc',
  });
  return new BridgeEventEmitter(statusFetcher, async () => true, {
    healthCheckIntervalMs: 10_000,
    pollIntervalMs: 10_000,
  });
}

describe('#858 — TelemetryClient timer lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts a flush timer only when an endpoint is configured', () => {
    const withEndpoint = new TelemetryClient({ endpoint: TELEMETRY_ENDPOINT, intervalMs: 60_000 });
    expect(vi.getTimerCount()).toBe(1);
    withEndpoint.destroy();
    expect(vi.getTimerCount()).toBe(0);

    const withoutEndpoint = new TelemetryClient({ intervalMs: 60_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('destroy() flushes queued events one last time, then stops the timer', () => {
    const send = vi.fn();
    const client = new TelemetryClient({
      endpoint: TELEMETRY_ENDPOINT,
      transport: { send },
      intervalMs: 60_000,
    });

    client.record({ method: 'getQuote', responseTimeMs: 12 });
    expect(send).not.toHaveBeenCalled();

    client.destroy();

    expect(send).toHaveBeenCalledOnce();
    const sent = send.mock.calls[0][0];
    expect(Array.isArray(sent) ? sent[0].method : sent.method).toBe('getQuote');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not record new events after destroy()', () => {
    const send = vi.fn();
    const client = new TelemetryClient({
      endpoint: TELEMETRY_ENDPOINT,
      transport: { send },
      intervalMs: 60_000,
    });

    client.destroy();
    client.record({ method: 'getQuote', responseTimeMs: 1 });
    vi.advanceTimersByTime(120_000);

    expect(send).not.toHaveBeenCalled();
  });

  it('destroy() is idempotent and flush() can be called explicitly', () => {
    const send = vi.fn();
    const client = new TelemetryClient({
      endpoint: TELEMETRY_ENDPOINT,
      transport: { send },
      intervalMs: 60_000,
    });

    client.record({ method: 'health', responseTimeMs: 3 });
    client.flush();
    expect(send).toHaveBeenCalledTimes(1);

    client.destroy();
    client.destroy();
    expect(send).toHaveBeenCalledTimes(1); // nothing left to flush
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('#858 — client destroy() stops every timer it started', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('BridgeClient.destroy() clears the telemetry timer', () => {
    const client = new BridgeClient({
      baseUrl: BASE_URL,
      telemetry: { endpoint: TELEMETRY_ENDPOINT, intervalMs: 60_000 },
    });
    expect(vi.getTimerCount()).toBe(1);

    client.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('BridgeClient.destroy() is safe when no telemetry is configured', () => {
    const client = new BridgeClient({ baseUrl: BASE_URL });
    expect(vi.getTimerCount()).toBe(0);

    expect(() => client.destroy()).not.toThrow();
    expect(() => client.destroy()).not.toThrow();
  });

  it('OfflineBridgeClient.destroy() clears both the queue poll and telemetry', () => {
    const client = new OfflineBridgeClient({
      baseUrl: BASE_URL,
      telemetry: { endpoint: TELEMETRY_ENDPOINT, intervalMs: 60_000 },
      offlineOptions: { healthCheckIntervalMs: 5_000 },
    });

    expect(vi.getTimerCount()).toBe(2);

    client.destroy();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('OfflineQueue stops polling the health endpoint after destroy()', async () => {
    const checkHealth = vi.fn().mockResolvedValue(true);
    const queue = new OfflineQueue(vi.fn(), checkHealth, { healthCheckIntervalMs: 5_000 });
    expect(vi.getTimerCount()).toBe(1);

    queue.destroy();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(checkHealth).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('BridgeEventEmitter.destroy() clears the health timer', () => {
    const emitter = makeEmitter();
    expect(vi.getTimerCount()).toBe(1);

    emitter.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('#858 — every SDK interval is unref()\'d', () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>;
  let unref: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    unref = vi.fn();
    const handle = { unref } as unknown as ReturnType<typeof setInterval>;
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(handle);
    clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('TelemetryClient unrefs its flush timer', () => {
    const client = new TelemetryClient({ endpoint: TELEMETRY_ENDPOINT, intervalMs: 60_000 });

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();

    client.destroy();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
  });

  it('BridgeEventEmitter unrefs its health timer', () => {
    const emitter = makeEmitter();

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();

    emitter.destroy();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
  });

  it('OfflineQueue unrefs its health timer', async () => {
    const queue = new OfflineQueue(vi.fn(), vi.fn(), { healthCheckIntervalMs: 5_000 });
    await Promise.resolve();

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();

    queue.destroy();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
  });
});
