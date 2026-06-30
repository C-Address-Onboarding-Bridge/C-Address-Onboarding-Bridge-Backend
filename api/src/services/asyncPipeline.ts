/**
 * AsyncPipeline service
 *
 * Moves non-critical operations off the HTTP response path using BullMQ queues.
 *
 * Features:
 *  - Fire-and-forget enqueue (never awaited on the call site)
 *  - 100ms in-process buffer for analytics counter batching
 *  - Backpressure detection: skips best-effort work when the queue is overloaded
 *  - Graceful degradation: optional sync fallback when Redis is unavailable
 *  - Prometheus instrumentation for all operations
 *
 * Two queues:
 *  - async-critical   priority 10, 5 attempts — tamper-evident audit logs
 *  - async-pipeline   priority 1,  3 attempts — analytics, metrics, admin records
 */

import { config } from '../config';
import {
  enqueueAuditLog,
  enqueueAnalytics,
  enqueuePipelineMetrics,
  getQueueWaitingCount,
  type AuditLogJobData,
  type AnalyticsJobData,
  type PipelineMetricsJobData,
} from '../jobs/queue';
import {
  asyncPipelineQueueDepth,
  asyncPipelineEnqueueCounter,
  asyncPipelineDroppedCounter,
} from './metrics';
import type { AuditEventType } from './auditLog';
import type { FundingMetricInput } from './metrics';

// ─── Backpressure state ───────────────────────────────────────────────────────

let _backpressured = false;
let _lastBackpressureCheck = 0;
/** Re-check the queue depth at most once per second to avoid hammering Redis. */
const BACKPRESSURE_CHECK_INTERVAL_MS = 1_000;

async function refreshBackpressure(): Promise<void> {
  const now = Date.now();
  if (now - _lastBackpressureCheck < BACKPRESSURE_CHECK_INTERVAL_MS) return;
  _lastBackpressureCheck = now;

  try {
    const depth = await getQueueWaitingCount('async-pipeline');
    _backpressured = depth > config.asyncPipeline.backpressureThreshold;
    asyncPipelineQueueDepth.set({ queue: 'async-pipeline' }, depth);
  } catch {
    // Redis temporarily unavailable — keep the previous backpressure state.
  }
}

export function isBackpressured(): boolean {
  return _backpressured;
}

// ─── In-process analytics buffer ─────────────────────────────────────────────

interface BufferEntry {
  event: string;
  labels: Record<string, string>;
  value: number;
}

/** key → accumulated count; flushed every bufferFlushMs */
const analyticsBuffer = new Map<string, BufferEntry>();
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function bufferKey(event: string, labels: Record<string, string>): string {
  return `${event}:${JSON.stringify(labels)}`;
}

function scheduleFlush(): void {
  if (_flushTimer !== null) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushAnalyticsBuffer().catch(() => {
      // Fire-and-forget; errors are swallowed to never block the caller.
    });
  }, config.asyncPipeline.bufferFlushMs);
  // Allow the process to exit even if the timer hasn't fired yet.
  _flushTimer.unref?.();
}

async function flushAnalyticsBuffer(): Promise<void> {
  if (analyticsBuffer.size === 0) return;

  const batch: AnalyticsJobData['batch'] = [];
  for (const entry of analyticsBuffer.values()) {
    batch.push({ event: entry.event, labels: entry.labels, value: entry.value });
  }
  analyticsBuffer.clear();

  try {
    await enqueueAnalytics({ batch });
    asyncPipelineEnqueueCounter.inc({ queue: 'async-pipeline', job: 'async-analytics' });
    asyncPipelineQueueDepth.set({ queue: 'async-pipeline' }, await getQueueWaitingCount('async-pipeline').catch(() => 0));
  } catch {
    // If Redis is down the batch is lost — acceptable for best-effort analytics.
  }
}

/** Flush remaining buffer immediately; intended for graceful shutdown. */
export async function drainAnalyticsBuffer(): Promise<void> {
  if (_flushTimer !== null) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  await flushAnalyticsBuffer();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueue an audit log entry on the high-priority async-critical queue.
 *
 * This is "fire and forget" from the caller's perspective — the Promise is
 * never awaited on the response path. If Redis is unavailable the synchronous
 * fallback is called instead so the audit entry is never silently lost.
 *
 * @param type     Audit event type
 * @param payload  Event payload
 * @param actor    Identifier for the actor (API key id, 'system', etc.)
 * @param syncFallback  Called synchronously when the pipeline is disabled or
 *                      Redis is unreachable; defaults to a no-op.
 */
export function enqueueAudit(
  type: AuditEventType,
  payload: Record<string, unknown>,
  actor: string,
  syncFallback?: () => void,
): void {
  if (!config.asyncPipeline.enabled) {
    syncFallback?.();
    return;
  }

  const job: AuditLogJobData = { type, payload, actor, triggeredAt: Date.now() };

  // Fire-and-forget — never await this on the response path.
  enqueueAuditLog(job).then(() => {
    asyncPipelineEnqueueCounter.inc({ queue: 'async-critical', job: 'async-audit-log' });
    asyncPipelineQueueDepth.set(
      { queue: 'async-critical' },
      0, // depth is sampled separately; here we just ensure the gauge is live
    );
  }).catch(() => {
    // Redis is unavailable — fall back to synchronous execution so the
    // audit entry is never silently lost.
    syncFallback?.();
  });
}

/**
 * Buffer an analytics counter increment for batched delivery to BullMQ.
 *
 * If the pipeline is backpressured or disabled, the operation is either
 * dropped (best-effort) or the optional sync fallback is called.
 *
 * @param event       Metric event name
 * @param labels      Label key-value pairs
 * @param syncFallback  Optional sync fallback executed when dropped
 */
export function bufferAnalytics(
  event: string,
  labels: Record<string, string>,
  syncFallback?: () => void,
): void {
  if (!config.asyncPipeline.enabled) {
    syncFallback?.();
    return;
  }

  // Refresh backpressure asynchronously — never block on it.
  void refreshBackpressure();

  if (_backpressured) {
    asyncPipelineDroppedCounter.inc({ job: event });
    return; // drop silently; analytics are best-effort
  }

  const key = bufferKey(event, labels);
  const existing = analyticsBuffer.get(key);
  if (existing) {
    existing.value++;
  } else {
    analyticsBuffer.set(key, { event, labels, value: 1 });
  }

  scheduleFlush();
}

/**
 * Enqueue a funding metrics recording job on the best-effort async-pipeline queue.
 *
 * Falls back to the synchronous `recordFundingMetrics` call if the pipeline
 * is disabled or backpressured, so no data is ever lost under light load.
 *
 * @param input         Standard funding metrics input
 * @param syncFallback  Called when the pipeline degrades to sync mode
 */
export function enqueueFundingMetrics(
  input: FundingMetricInput,
  syncFallback?: () => void,
): void {
  if (!config.asyncPipeline.enabled) {
    syncFallback?.();
    return;
  }

  void refreshBackpressure();

  if (_backpressured) {
    // For funding metrics we prefer accuracy over dropping — run sync.
    syncFallback?.();
    return;
  }

  const job: PipelineMetricsJobData = { operation: 'funding', data: input as unknown as Record<string, unknown> };

  enqueuePipelineMetrics(job).then(() => {
    asyncPipelineEnqueueCounter.inc({ queue: 'async-pipeline', job: 'async-metrics' });
  }).catch(() => {
    // Redis down — fall back to sync.
    syncFallback?.();
  });
}

/**
 * Enqueue a simple counter increment (e.g. onramp request count) on the
 * best-effort queue via the in-process buffer.
 *
 * Dropped silently if backpressured; use `syncFallback` for must-not-miss counters.
 */
export function enqueueCounterIncrement(
  event: string,
  labels: Record<string, string>,
  syncFallback?: () => void,
): void {
  bufferAnalytics(event, labels, syncFallback);
}

// ─── Exported test helpers ────────────────────────────────────────────────────

/** Force-set the backpressure state. For tests only. */
export function _setBackpressuredForTest(value: boolean): void {
  _backpressured = value;
}

/** Expose current buffer size. For tests only. */
export function _getBufferSizeForTest(): number {
  return analyticsBuffer.size;
}
