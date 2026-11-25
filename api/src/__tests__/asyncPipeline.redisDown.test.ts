/**
 * #1052: with the Redis producer connection mocked as down, enqueue paths
 * must take their sync fallback promptly and increment the dropped counter,
 * instead of parking forever in ioredis' offline queue.
 *
 * The `enqueueAuditLog` mock here NEVER settles in the hang scenario - that's
 * the exact failure mode the issue describes. The bounded wait in
 * `enqueueAudit` is what makes this test terminate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.NODE_ENV = 'test';

const {
  mockEnqueueAuditLog,
  mockEnqueuePipelineMetrics,
  mockEnqueueAnalytics,
  mockGetQueueWaitingCount,
  mockMetrics,
} = vi.hoisted(() => ({
  mockEnqueueAuditLog: vi.fn(),
  mockEnqueuePipelineMetrics: vi.fn(),
  mockEnqueueAnalytics: vi.fn().mockResolvedValue(undefined),
  mockGetQueueWaitingCount: vi.fn().mockResolvedValue(0),
  mockMetrics: {
    asyncPipelineQueueDepth: { set: vi.fn() },
    asyncPipelineEnqueueCounter: { inc: vi.fn() },
    asyncPipelineDroppedCounter: { inc: vi.fn() },
  },
}));

vi.mock('../jobs/queue', () => ({
  enqueueAuditLog: mockEnqueueAuditLog,
  enqueueAnalytics: mockEnqueueAnalytics,
  enqueuePipelineMetrics: mockEnqueuePipelineMetrics,
  getQueueWaitingCount: mockGetQueueWaitingCount,
}));

vi.mock('../services/metrics', () => mockMetrics);

vi.mock('../services/auditLog', () => ({ integrityAuditLog: { append: vi.fn() } }));

vi.mock('../config', () => ({
  config: {
    redis: { enabled: true },
    jobs: { enabled: true },
    asyncPipeline: {
      enabled: true,
      backpressureThreshold: 100,
      bufferFlushMs: 10,
    },
  },
}));

import {
  enqueueAudit,
  enqueueFundingMetrics,
  _ENQUEUE_TIMEOUT_MS_FOR_TEST,
} from '../services/asyncPipeline';
import { config } from '../config';

describe('#1052 enqueue fallback when Redis producer is down', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore "normal" config; individual tests override as needed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = config as any;
    c.redis.enabled = true;
    c.jobs.enabled = true;
    c.asyncPipeline.enabled = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueueAudit takes the fallback within the bounded timeout when add() never settles', async () => {
    vi.useFakeTimers();

    // Simulates ioredis' offline queue: the promise is created but never settles.
    mockEnqueueAuditLog.mockImplementationOnce(() => new Promise<void>(() => {}));

    const fallback = vi.fn();
    enqueueAudit('admin_operation', {}, 'admin', fallback);

    // Just before the timeout: fallback must NOT have fired yet.
    await vi.advanceTimersByTimeAsync(_ENQUEUE_TIMEOUT_MS_FOR_TEST - 1);
    expect(fallback).not.toHaveBeenCalled();

    // Cross the boundary: fallback fires, dropped counter increments.
    await vi.advanceTimersByTimeAsync(2);
    expect(fallback).toHaveBeenCalledOnce();
    expect(mockMetrics.asyncPipelineDroppedCounter.inc).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'async-critical', job: 'audit-log' }),
    );
    expect(mockMetrics.asyncPipelineEnqueueCounter.inc).not.toHaveBeenCalled();
  });

  it('enqueueAudit takes the fallback immediately when add() rejects', async () => {
    mockEnqueueAuditLog.mockRejectedValueOnce(new Error('Connection is closed.'));

    const fallback = vi.fn();
    enqueueAudit('admin_operation', {}, 'admin', fallback);

    // A few microtasks later the reject path should have run.
    await Promise.resolve();
    await Promise.resolve();

    expect(fallback).toHaveBeenCalledOnce();
    expect(mockMetrics.asyncPipelineDroppedCounter.inc).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'async-critical', job: 'audit-log' }),
    );
  });

  it('enqueueAudit short-circuits to the fallback when config.redis.enabled is false (no enqueue attempted)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).redis.enabled = false;

    const fallback = vi.fn();
    enqueueAudit('admin_operation', {}, 'admin', fallback);

    // Synchronous: fallback must fire before any await.
    expect(fallback).toHaveBeenCalledOnce();
    expect(mockEnqueueAuditLog).not.toHaveBeenCalled();
  });

  it('enqueueFundingMetrics takes the fallback when add() rejects', async () => {
    mockEnqueuePipelineMetrics.mockRejectedValueOnce(new Error('Connection is closed.'));

    const fallback = vi.fn();
    enqueueFundingMetrics({ source: 'api', status: 'success' }, fallback);

    await Promise.resolve();
    await Promise.resolve();

    expect(fallback).toHaveBeenCalledOnce();
  });
});
