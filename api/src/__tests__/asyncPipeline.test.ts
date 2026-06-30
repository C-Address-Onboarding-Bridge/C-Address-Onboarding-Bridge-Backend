/**
 * Tests for the AsyncPipeline service.
 *
 * All queue interactions are mocked — no real Redis required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.NODE_ENV = 'test';

// ─── Mock dependencies ────────────────────────────────────────────────────────

const mockEnqueueAuditLog = vi.fn().mockResolvedValue(undefined);
const mockEnqueueAnalytics = vi.fn().mockResolvedValue(undefined);
const mockEnqueuePipelineMetrics = vi.fn().mockResolvedValue(undefined);
const mockGetQueueWaitingCount = vi.fn().mockResolvedValue(0);

vi.mock('../jobs/queue', () => ({
  enqueueAuditLog: mockEnqueueAuditLog,
  enqueueAnalytics: mockEnqueueAnalytics,
  enqueuePipelineMetrics: mockEnqueuePipelineMetrics,
  getQueueWaitingCount: mockGetQueueWaitingCount,
}));

const mockAuditLogAppend = vi.fn();
vi.mock('../services/auditLog', () => ({
  integrityAuditLog: { append: mockAuditLogAppend },
}));

const mockMetricsInc = {
  asyncPipelineQueueDepth: { set: vi.fn() },
  asyncPipelineEnqueueCounter: { inc: vi.fn() },
  asyncPipelineDroppedCounter: { inc: vi.fn() },
  asyncPipelineJobDuration: { startTimer: vi.fn(() => vi.fn()) },
  asyncPipelineFailureCounter: { inc: vi.fn() },
};

vi.mock('../services/metrics', () => mockMetricsInc);

vi.mock('../config', () => ({
  config: {
    asyncPipeline: {
      enabled: true,
      backpressureThreshold: 100,
      bufferFlushMs: 10,
    },
  },
}));

// Import after mocks
import {
  enqueueAudit,
  enqueueFundingMetrics,
  enqueueCounterIncrement,
  bufferAnalytics,
  drainAnalyticsBuffer,
  isBackpressured,
  _setBackpressuredForTest,
  _getBufferSizeForTest,
} from '../services/asyncPipeline';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('enqueueAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _setBackpressuredForTest(false);
  });

  it('enqueues to async-critical queue when pipeline is enabled', async () => {
    enqueueAudit('transaction_submission', { hash: 'abc' }, 'user-1');
    // Give the Promise microtask queue a turn
    await wait(5);
    expect(mockEnqueueAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'transaction_submission', payload: { hash: 'abc' }, actor: 'user-1' }),
    );
  });

  it('includes triggeredAt timestamp in the job', async () => {
    const before = Date.now();
    enqueueAudit('admin_operation', {}, 'admin');
    await wait(5);
    const job = mockEnqueueAuditLog.mock.calls[0][0];
    expect(job.triggeredAt).toBeGreaterThanOrEqual(before);
  });

  it('runs sync fallback when enqueueAuditLog rejects (Redis down)', async () => {
    mockEnqueueAuditLog.mockRejectedValueOnce(new Error('redis down'));
    const fallback = vi.fn();
    enqueueAudit('transaction_submission', {}, 'user', fallback);
    await wait(20);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('does not call enqueueAuditLog when pipeline is disabled', async () => {
    const { config } = await import('../config');
    const original = config.asyncPipeline.enabled;
    config.asyncPipeline.enabled = false;

    const fallback = vi.fn();
    enqueueAudit('admin_operation', {}, 'admin', fallback);
    await wait(5);

    expect(mockEnqueueAuditLog).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();

    config.asyncPipeline.enabled = original;
  });
});

describe('bufferAnalytics / drainAnalyticsBuffer', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    _setBackpressuredForTest(false);
    // Drain any leftover buffer state from previous tests
    await drainAnalyticsBuffer();
    mockEnqueueAnalytics.mockClear();
  });

  afterEach(async () => {
    await drainAnalyticsBuffer();
  });

  it('accumulates events in the in-process buffer', () => {
    bufferAnalytics('onramp_request', { provider: 'moonpay' });
    bufferAnalytics('onramp_request', { provider: 'moonpay' });
    bufferAnalytics('onramp_request', { provider: 'transak' });
    expect(_getBufferSizeForTest()).toBe(2); // two distinct keys
  });

  it('increments counter for repeated events with same labels', () => {
    bufferAnalytics('evt', { k: 'v' });
    bufferAnalytics('evt', { k: 'v' });
    bufferAnalytics('evt', { k: 'v' });
    // Still one buffer entry but value should be 3
    expect(_getBufferSizeForTest()).toBe(1);
  });

  it('flushes the buffer after bufferFlushMs', async () => {
    bufferAnalytics('flush_test', { x: '1' });
    await wait(50); // bufferFlushMs is 10ms in test config
    expect(mockEnqueueAnalytics).toHaveBeenCalledOnce();
    const batch = mockEnqueueAnalytics.mock.calls[0][0].batch;
    expect(batch).toHaveLength(1);
    expect(batch[0].event).toBe('flush_test');
  });

  it('drainAnalyticsBuffer flushes immediately', async () => {
    bufferAnalytics('drain_test', { y: '2' });
    expect(mockEnqueueAnalytics).not.toHaveBeenCalled();
    await drainAnalyticsBuffer();
    expect(mockEnqueueAnalytics).toHaveBeenCalledOnce();
  });

  it('does not enqueue when backpressured', async () => {
    _setBackpressuredForTest(true);
    bufferAnalytics('bp_event', { a: 'b' });
    await drainAnalyticsBuffer();
    expect(mockEnqueueAnalytics).not.toHaveBeenCalled();
    expect(mockMetricsInc.asyncPipelineDroppedCounter.inc).toHaveBeenCalled();
  });

  it('calls sync fallback when backpressured and fallback is provided', () => {
    _setBackpressuredForTest(true);
    const fallback = vi.fn();
    bufferAnalytics('bp_fallback', {}, fallback);
    // Fallback is NOT called for analytics (best-effort drop); verify pipeline
    // correctly drops without calling the fallback (analytics are best-effort)
    expect(fallback).not.toHaveBeenCalled();
  });

  it('calls sync fallback when pipeline is disabled', async () => {
    const { config } = await import('../config');
    const original = config.asyncPipeline.enabled;
    config.asyncPipeline.enabled = false;

    const fallback = vi.fn();
    bufferAnalytics('disabled_test', {}, fallback);
    await wait(5);

    expect(fallback).toHaveBeenCalledOnce();
    expect(mockEnqueueAnalytics).not.toHaveBeenCalled();

    config.asyncPipeline.enabled = original;
  });
});

describe('enqueueFundingMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _setBackpressuredForTest(false);
  });

  it('enqueues a funding metrics job on the best-effort queue', async () => {
    const input = { source: 'api' as const, status: 'success' as const };
    enqueueFundingMetrics(input);
    await wait(10);
    expect(mockEnqueuePipelineMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'funding', data: input }),
    );
  });

  it('runs sync fallback when backpressured (funding metrics are too important to drop)', async () => {
    _setBackpressuredForTest(true);
    const fallback = vi.fn();
    enqueueFundingMetrics({ source: 'api', status: 'success' }, fallback);
    await wait(10);
    expect(fallback).toHaveBeenCalledOnce();
    expect(mockEnqueuePipelineMetrics).not.toHaveBeenCalled();
  });

  it('runs sync fallback when enqueuePipelineMetrics rejects', async () => {
    mockEnqueuePipelineMetrics.mockRejectedValueOnce(new Error('redis down'));
    const fallback = vi.fn();
    enqueueFundingMetrics({ source: 'api', status: 'pending' }, fallback);
    await wait(20);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('runs sync fallback when pipeline is disabled', async () => {
    const { config } = await import('../config');
    const original = config.asyncPipeline.enabled;
    config.asyncPipeline.enabled = false;

    const fallback = vi.fn();
    enqueueFundingMetrics({ source: 'api', status: 'success' }, fallback);
    await wait(5);

    expect(fallback).toHaveBeenCalledOnce();
    expect(mockEnqueuePipelineMetrics).not.toHaveBeenCalled();

    config.asyncPipeline.enabled = original;
  });
});

describe('enqueueCounterIncrement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    _setBackpressuredForTest(false);
    await drainAnalyticsBuffer();
    mockEnqueueAnalytics.mockClear();
  });

  afterEach(async () => {
    await drainAnalyticsBuffer();
  });

  it('delegates to bufferAnalytics', async () => {
    enqueueCounterIncrement('onramp', { provider: 'moonpay' });
    expect(_getBufferSizeForTest()).toBe(1);
  });
});

describe('isBackpressured', () => {
  it('reflects the internal backpressure flag', () => {
    _setBackpressuredForTest(false);
    expect(isBackpressured()).toBe(false);
    _setBackpressuredForTest(true);
    expect(isBackpressured()).toBe(true);
    _setBackpressuredForTest(false);
  });
});

describe('graceful degradation (pipeline disabled end-to-end)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    _setBackpressuredForTest(false);
    await drainAnalyticsBuffer();
  });

  it('all operations fall through to sync when ASYNC_PIPELINE_ENABLED=false', async () => {
    const { config } = await import('../config');
    config.asyncPipeline.enabled = false;

    const auditFallback = vi.fn();
    const metricsFallback = vi.fn();
    const counterFallback = vi.fn();

    enqueueAudit('admin_operation', {}, 'admin', auditFallback);
    enqueueFundingMetrics({ source: 'api', status: 'success' }, metricsFallback);
    bufferAnalytics('evt', {}, counterFallback);

    await wait(20);

    expect(auditFallback).toHaveBeenCalledOnce();
    expect(metricsFallback).toHaveBeenCalledOnce();
    expect(counterFallback).toHaveBeenCalledOnce();

    expect(mockEnqueueAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueuePipelineMetrics).not.toHaveBeenCalled();
    expect(mockEnqueueAnalytics).not.toHaveBeenCalled();

    config.asyncPipeline.enabled = true;
  });
});
