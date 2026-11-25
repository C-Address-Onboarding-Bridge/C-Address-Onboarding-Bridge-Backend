import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.NODE_ENV = 'test';

const hoisted = vi.hoisted(() => ({
  queueNames: [] as string[],
  scheduled: [] as string[],
  repeatOpts: [] as Array<{ name: string; opts: unknown }>,
  workerNames: [] as string[],
  workerOpts: [] as Array<{ name: string; concurrency: number }>,
  scheduleRecurringJobsMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(public name: string) {
      hoisted.queueNames.push(name);
    }
    async add(name: string, _data: unknown, opts?: unknown) {
      hoisted.scheduled.push(name);
      hoisted.repeatOpts.push({ name, opts });
    }
    async close() {}
  },
  Worker: class {
    constructor(name: string, _processor: unknown, opts: { concurrency: number }) {
      hoisted.workerNames.push(name);
      hoisted.workerOpts.push({ name, concurrency: opts.concurrency });
    }
    on() {}
    async close() {}
  },
}));

// Mock the real scheduler so the entry-point test asserts the call without Redis.
vi.mock('../jobs/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../jobs/queue')>();
  return { ...actual, scheduleRecurringJobs: hoisted.scheduleRecurringJobsMock };
});

import { scheduleRecurringJobs } from '../jobs/queue';
import { startWorkers, main } from '../jobs/worker';
import { config } from '../config';

// Idempotency, nonce and replay keys all live in Redis with a TTL, so there is
// nothing for a recurring cleanup job to prune (#687).
describe('job registration', () => {
  beforeEach(() => {
    hoisted.queueNames.length = 0;
    hoisted.scheduled.length = 0;
    hoisted.repeatOpts.length = 0;
    hoisted.workerNames.length = 0;
    hoisted.workerOpts.length = 0;
    hoisted.scheduleRecurringJobsMock.mockClear();
  });

  it('does not schedule a cleanup job', async () => {
    await scheduleRecurringJobs();

    expect(hoisted.scheduled).toEqual(expect.arrayContaining(['cache-warmup', 'metrics-compute']));
    expect(hoisted.scheduled).not.toContain('cleanup');
    expect(hoisted.queueNames).not.toContain('cleanup');
  });

  it('schedules recurring jobs with stable repeat keys (idempotent across restarts)', async () => {
    await scheduleRecurringJobs();

    const cacheWarmup = hoisted.repeatOpts.find((r) => r.name === 'cache-warmup');
    const metrics = hoisted.repeatOpts.find((r) => r.name === 'metrics-compute');

    expect(cacheWarmup).toBeDefined();
    expect(metrics).toBeDefined();
    expect((cacheWarmup!.opts as { repeat: { key: string } }).repeat.key).toBe('recurring:cache-warmup');
    expect((metrics!.opts as { repeat: { key: string } }).repeat.key).toBe('recurring:metrics-compute');
  });

  it('does not start a cleanup worker', () => {
    startWorkers();

    expect(hoisted.workerNames).toContain('webhook-retry');
    expect(hoisted.workerNames).not.toContain('cleanup');
  });

  it('startWorkers() reads concurrency from config.jobs.concurrency', () => {
    startWorkers();

    const byName = Object.fromEntries(hoisted.workerOpts.map((w) => [w.name, w.concurrency]));
    expect(byName['cache-warmup']).toBe(config.jobs.concurrency.cacheWarmup);
    expect(byName['metrics-compute']).toBe(config.jobs.concurrency.metrics);
    expect(byName['async-critical']).toBe(config.jobs.concurrency.asyncCritical);
    expect(byName['async-pipeline']).toBe(config.jobs.concurrency.asyncPipeline);
    expect(byName['webhook-retry']).toBe(config.jobs.concurrency.webhookRetry);
  });

  it('worker entry point schedules recurring jobs once on startup', async () => {
    await main();

    expect(hoisted.scheduleRecurringJobsMock).toHaveBeenCalledTimes(1);
    expect(hoisted.workerNames).toEqual(
      expect.arrayContaining(['cache-warmup', 'metrics-compute', 'async-critical', 'async-pipeline', 'webhook-retry']),
    );
  });
});
