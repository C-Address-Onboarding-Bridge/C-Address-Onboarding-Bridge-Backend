/**
 * Tests for issues #257, #258, #259, #260
 *
 * #257 – SimpleCache: updating an existing key at capacity must not evict other entries
 * #258 – TelemetryClient: queue must not grow unboundedly when no endpoint is set
 * #259 – TelemetryClient: queueing, flush, and both transport implementations
 * #260 – OfflineQueue: entries exceeding maxRetryCount are dropped;
 *                       non-retryable errors are never retried
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SimpleCache } from '../src/cache';
import {
  TelemetryClient,
  TelemetryEvent,
  TelemetryTransport,
  NoopTelemetryTransport,
  FetchTelemetryTransport,
} from '../src/telemetry';
import { OfflineQueue } from '../src/offline';
import { QueueEntry } from '../src/types';
import { ValidationError, NetworkError } from '../src/errors';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeEntry(id = '1'): Omit<QueueEntry, 'id' | 'timestamp' | 'retryCount'> {
  return { method: 'GET', path: '/api/v1/test' };
}

// ─── #257 SimpleCache ─────────────────────────────────────────────────────────

describe('#257 SimpleCache — eviction on set()', () => {
  it('evicts the oldest entry when a NEW key is inserted at capacity', () => {
    const cache = new SimpleCache({ maxEntries: 2 });
    cache.set('a', 'value-a', 60_000);
    cache.set('b', 'value-b', 60_000);
    // Insert a third, genuinely new key — 'a' (oldest) should be evicted
    cache.set('c', 'value-c', 60_000);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).not.toBeUndefined();
    expect(cache.get('c')).not.toBeUndefined();
  });

  it('does NOT evict any entry when updating an existing key at capacity', () => {
    const cache = new SimpleCache({ maxEntries: 2 });
    cache.set('a', 'value-a', 60_000);
    cache.set('b', 'value-b', 60_000);

    // Update 'a' — the map size stays at 2, so no eviction should happen
    cache.set('a', 'value-a-updated', 60_000);

    expect(cache.get('a')?.value).toBe('value-a-updated');
    expect(cache.get('b')).not.toBeUndefined();
  });

  it('reflects the updated value after an in-place update', () => {
    const cache = new SimpleCache({ maxEntries: 3 });
    cache.set('x', 'original', 60_000);
    cache.set('x', 'updated', 60_000);

    expect(cache.get('x')?.value).toBe('updated');
  });
});

// ─── #258 TelemetryClient — no endpoint ──────────────────────────────────────

describe('#258 TelemetryClient — unbounded queue with no endpoint', () => {
  it('is disabled by default when no endpoint is configured', () => {
    const client = new TelemetryClient();
    expect(client.getQueueSize()).toBe(0);
    client.record({ method: 'getQuote', responseTimeMs: 10 });
    // Should remain 0 because the client is disabled
    expect(client.getQueueSize()).toBe(0);
  });

  it('queue does not grow unboundedly — stays at 0 with no endpoint', () => {
    const client = new TelemetryClient();
    for (let i = 0; i < 500; i++) {
      client.record({ method: 'getQuote', responseTimeMs: i });
    }
    expect(client.getQueueSize()).toBe(0);
  });

  it('can be explicitly enabled even without an endpoint, but caps at MAX_QUEUE_SIZE', () => {
    const client = new TelemetryClient({ enabled: true });
    // Record more than the cap (100)
    for (let i = 0; i < 150; i++) {
      client.record({ method: 'getQuote', responseTimeMs: i });
    }
    // Queue must never exceed the cap
    expect(client.getQueueSize()).toBeLessThanOrEqual(100);
  });
});

// ─── #259 TelemetryClient — queueing, flush, transports ──────────────────────

describe('#259 TelemetryClient — queueing and flush behaviour', () => {
  it('queues events when enabled with an endpoint', () => {
    const client = new TelemetryClient({ endpoint: 'https://telemetry.example.com', enabled: true });
    client.record({ method: 'getQuote', responseTimeMs: 100 });
    client.record({ method: 'getStatus', responseTimeMs: 50 });
    expect(client.getQueueSize()).toBe(2);
  });

  it('flush() drains the queue', () => {
    const client = new TelemetryClient({ endpoint: 'https://telemetry.example.com', enabled: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    client.record({ method: 'getQuote', responseTimeMs: 100 });
    expect(client.getQueueSize()).toBe(1);

    client.flush();
    expect(client.getQueueSize()).toBe(0);

    vi.restoreAllMocks();
  });

  it('flush() is a no-op when the queue is already empty', () => {
    const client = new TelemetryClient({ endpoint: 'https://telemetry.example.com', enabled: true });
    expect(() => client.flush()).not.toThrow();
    expect(client.getQueueSize()).toBe(0);
  });

  it('events include sdkVersion, nodeVersion, and platform fields', () => {
    const sent: TelemetryEvent[] = [];
    const transport: TelemetryTransport = { send: (e) => sent.push(e) };

    const client = new TelemetryClient({ transport, enabled: true });
    client.record({ method: 'getQuote', responseTimeMs: 42 });
    client.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: 'getQuote',
      responseTimeMs: 42,
    });
    expect(typeof sent[0].sdkVersion).toBe('string');
    expect(typeof sent[0].nodeVersion).toBe('string');
    expect(typeof sent[0].platform).toBe('string');
  });

  it('errorType field is included when provided', () => {
    const sent: TelemetryEvent[] = [];
    const transport: TelemetryTransport = { send: (e) => sent.push(e) };

    const client = new TelemetryClient({ transport, enabled: true });
    client.record({ method: 'getStatus', responseTimeMs: 10, errorType: 'NetworkError' });
    client.flush();

    expect(sent[0].errorType).toBe('NetworkError');
  });
});

describe('#259 NoopTelemetryTransport', () => {
  it('send() does not throw', () => {
    const transport = new NoopTelemetryTransport();
    const event: TelemetryEvent = {
      sdkVersion: '0.1.0',
      nodeVersion: 'v20.0.0',
      platform: 'linux',
      method: 'getQuote',
      responseTimeMs: 10,
    };
    expect(() => transport.send(event)).not.toThrow();
  });
});

describe('#259 FetchTelemetryTransport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls fetch with correct URL, method, and headers', () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const transport = new FetchTelemetryTransport('https://telemetry.example.com/events');
    const event: TelemetryEvent = {
      sdkVersion: '0.1.0',
      nodeVersion: 'v20.0.0',
      platform: 'linux',
      method: 'getQuote',
      responseTimeMs: 55,
    };

    transport.send(event);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://telemetry.example.com/events');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toMatchObject({ method: 'getQuote', responseTimeMs: 55 });
  });

  it('swallows fetch errors silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const transport = new FetchTelemetryTransport('https://telemetry.example.com/events');
    const event: TelemetryEvent = {
      sdkVersion: '0.1.0',
      nodeVersion: 'v20.0.0',
      platform: 'linux',
      method: 'getQuote',
      responseTimeMs: 10,
    };

    // Should not throw; errors are caught internally
    await expect(async () => {
      transport.send(event);
      // yield microtask queue so the void promise resolves/rejects
      await new Promise((r) => setTimeout(r, 0));
    }).not.toThrow();
  });
});

// ─── #260 OfflineQueue — max retries & retryable classification ───────────────

describe('#260 OfflineQueue — max retry count', () => {
  let queue: OfflineQueue;

  afterEach(() => {
    queue?.destroy();
  });

  it('drops an entry after it exceeds maxRetryCount', async () => {
    let callCount = 0;
    // Always fail with a retryable error
    const execute = vi.fn(async (_entry: QueueEntry) => {
      callCount++;
      throw new NetworkError('server unreachable');
    });
    const checkHealth = vi.fn(async () => true);

    queue = new OfflineQueue(execute, checkHealth, {
      maxRetryCount: 2,
      healthCheckIntervalMs: 100_000, // prevent auto-trigger
    });

    await (queue as unknown as { enqueue: OfflineQueue['enqueue'] }).enqueue(makeEntry());

    // Drive replay manually 3 times
    const replay = (queue as unknown as { replay: () => Promise<void> }).replay.bind(queue);
    queue['replaying'] = false;
    await replay(); // retryCount → 1
    queue['replaying'] = false;
    await replay(); // retryCount → 2
    queue['replaying'] = false;
    await replay(); // retryCount → 3 > maxRetryCount=2 → dropped

    expect(queue.getQueue()).toHaveLength(0);
  });

  it('retains an entry that has not yet hit maxRetryCount', async () => {
    const execute = vi.fn(async (_entry: QueueEntry) => {
      throw new NetworkError('server unreachable');
    });
    const checkHealth = vi.fn(async () => true);

    queue = new OfflineQueue(execute, checkHealth, {
      maxRetryCount: 3,
      healthCheckIntervalMs: 100_000,
    });

    await (queue as unknown as { enqueue: OfflineQueue['enqueue'] }).enqueue(makeEntry());

    const replay = (queue as unknown as { replay: () => Promise<void> }).replay.bind(queue);
    queue['replaying'] = false;
    await replay(); // retryCount → 1

    expect(queue.getQueue()).toHaveLength(1);
    expect(queue.getQueue()[0].retryCount).toBe(1);
  });
});

describe('#260 OfflineQueue — non-retryable error classification', () => {
  let queue: OfflineQueue;

  afterEach(() => {
    queue?.destroy();
  });

  it('immediately drops an entry that throws a non-retryable BridgeError (e.g. 400 Validation)', async () => {
    const execute = vi.fn(async (_entry: QueueEntry) => {
      throw new ValidationError('invalid address');
    });
    const checkHealth = vi.fn(async () => true);

    queue = new OfflineQueue(execute, checkHealth, {
      maxRetryCount: 5,
      healthCheckIntervalMs: 100_000,
    });

    await (queue as unknown as { enqueue: OfflineQueue['enqueue'] }).enqueue(makeEntry());

    const replay = (queue as unknown as { replay: () => Promise<void> }).replay.bind(queue);
    queue['replaying'] = false;
    await replay();

    // Should have been dropped immediately without incrementing retryCount
    expect(queue.getQueue()).toHaveLength(0);
  });

  it('does NOT drop an entry that throws a retryable NetworkError', async () => {
    let calls = 0;
    const execute = vi.fn(async (_entry: QueueEntry) => {
      calls++;
      if (calls === 1) throw new NetworkError('connection refused');
      // Succeeds on second attempt
    });
    const checkHealth = vi.fn(async () => true);

    queue = new OfflineQueue(execute, checkHealth, {
      maxRetryCount: 5,
      healthCheckIntervalMs: 100_000,
    });

    await (queue as unknown as { enqueue: OfflineQueue['enqueue'] }).enqueue(makeEntry());

    const replay = (queue as unknown as { replay: () => Promise<void> }).replay.bind(queue);
    queue['replaying'] = false;
    await replay(); // fails → retains entry

    expect(queue.getQueue()).toHaveLength(1);

    queue['replaying'] = false;
    await replay(); // succeeds → entry removed

    expect(queue.getQueue()).toHaveLength(0);
  });
});
