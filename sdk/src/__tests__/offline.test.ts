import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OfflineQueue } from '../offline';

describe('OfflineQueue.replay', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps entries enqueued while a replay is running', async () => {
    const queue = new OfflineQueue();

    const first = {
      id: 'first',
      method: 'POST',
      path: '/first',
      body: {},
      createdAt: Date.now(),
    } as any;
    const second = {
      id: 'second',
      method: 'POST',
      path: '/second',
      body: {},
      createdAt: Date.now(),
    } as any;

    queue.enqueue(first);

    const executeEntry = vi
      .spyOn(queue as any, 'executeEntry')
      .mockImplementation(async (entry: any) => {
        if (entry.id === 'first') {
          // Simulate a call failing with a network error mid-replay.
          queue.enqueue(second);
        }
      });

    await queue.replay();

    expect(executeEntry).toHaveBeenCalled();
    const remaining = (queue as any).queue as any[];
    expect(remaining.map((e) => e.id)).toContain('second');
    expect(remaining.map((e) => e.id)).not.toContain('first');
  });

  it('resets replaying even when executeEntry throws', async () => {
    const queue = new OfflineQueue();
    queue.enqueue({
      id: 'boom',
      method: 'POST',
      path: '/boom',
      body: {},
      createdAt: Date.now(),
    } as any);

    vi.spyOn(queue as any, 'executeEntry').mockRejectedValue(new Error('fatal'));
    vi.spyOn(queue as any, 'shouldRetry').mockReturnValue(false);

    await expect(queue.replay()).rejects.toThrow('fatal');
    expect((queue as any).replaying).toBe(false);
  });
});
