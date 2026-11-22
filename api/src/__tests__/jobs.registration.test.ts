import { describe, it, expect, vi } from 'vitest';

process.env.NODE_ENV = 'test';

const { queueNames, scheduled, workerNames } = vi.hoisted(() => ({
  queueNames: [] as string[],
  scheduled: [] as string[],
  workerNames: [] as string[],
}));

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(public name: string) {
      queueNames.push(name);
    }
    async add(name: string) {
      scheduled.push(name);
    }
    async close() {}
  },
  Worker: class {
    constructor(name: string) {
      workerNames.push(name);
    }
    on() {}
    async close() {}
  },
}));

import { scheduleRecurringJobs } from '../jobs/queue';
import { startWorkers } from '../jobs/worker';

// Idempotency, nonce and replay keys all live in Redis with a TTL, so there is
// nothing for a recurring cleanup job to prune (#687).
describe('job registration', () => {
  it('does not schedule a cleanup job', async () => {
    await scheduleRecurringJobs();

    expect(scheduled).toEqual(expect.arrayContaining(['cache-warmup', 'metrics-compute']));
    expect(scheduled).not.toContain('cleanup');
    expect(queueNames).not.toContain('cleanup');
  });

  it('does not start a cleanup worker', () => {
    startWorkers();

    expect(workerNames).toContain('webhook-retry');
    expect(workerNames).not.toContain('cleanup');
  });
});
