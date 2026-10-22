import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BridgeClient } from '../bridge';
import { OfflineQueue } from '../offline';
import { BridgeMockServer } from './mock-server';

describe('OfflineQueue', () => {
  let server: BridgeMockServer;
  let client: BridgeClient;

  beforeEach(async () => {
    server = new BridgeMockServer();
    await server.start();
    client = new BridgeClient({ baseUrl: server.url });
  });

  afterEach(async () => {
    await server.stop();
    vi.useRealTimers();
  });

  it('replays queued requests after coming back online with default health check path', async () => {
    vi.useFakeTimers();
    const queue = new OfflineQueue(client, { baseUrl: server.url });

    queue.setOnline(false);
    queue.enqueue('GET', '/api/v1/status');
    expect(queue.size).toBe(1);

    // Advance past the default health check interval; the default path must
    // hit the real /health route so the queue transitions back online.
    await vi.advanceTimersByTimeAsync(30000);

    expect(queue.isOnline).toBe(true);
    expect(queue.size).toBe(0);

    queue.destroy();
  });
});
