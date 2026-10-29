import { Queue, QueueOptions } from 'bullmq';
import { config } from '../config';

export type JobName =
  | 'cache-warmup'
  | 'metrics-compute'
  | 'async-audit-log'
  | 'async-analytics'
  | 'async-metrics'
  | 'webhook-retry';

export interface CacheWarmupData {
  assets: string[];
}

export interface MetricsData {
  period: 'hourly' | 'daily';
}

// ─── Async pipeline job payloads ─────────────────────────────────────────────

export interface AuditLogJobData {
  /** Maps to AuditEventType in auditLog.ts */
  type: string;
  payload: Record<string, unknown>;
  actor: string;
  /** ISO timestamp of when the event was originally triggered on the request path */
  triggeredAt: number;
}

export interface AnalyticsJobData {
  /**
   * Batched counter increments flushed from the in-process 100ms buffer.
   * Key is `${event}:${JSON.stringify(labels)}`, value is the accumulated count.
   */
  batch: Array<{
    event: string;
    labels: Record<string, string>;
    value: number;
  }>;
}

export interface PipelineMetricsJobData {
  operation: 'funding' | 'onramp' | 'admin';
  data: Record<string, unknown>;
}

/**
 * Delay before each webhook retry, indexed by the attempt that just failed.
 * Once every delay has been used the delivery is written to the DLQ.
 */
export const WEBHOOK_RETRY_DELAYS_MS = [10_000, 60_000, 300_000];

/**
 * Everything the worker needs to redeliver a webhook. The registration lives
 * in the API process, so the job must be self-contained.
 */
export interface WebhookRetryData {
  registrationId: string;
  url: string;
  event: string;
  /** Timestamp bound into the signature; resent as X-Webhook-Timestamp. */
  timestamp: number;
  payload: string;
  signature: string;
  data: unknown;
  attemptNumber: number;
}

export type JobData =
  | CacheWarmupData
  | MetricsData
  | AuditLogJobData
  | AnalyticsJobData
  | PipelineMetricsJobData
  | WebhookRetryData;

function parseRedisUrl(url: string): { host: string; port: number; password?: string; db?: number } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || 'localhost',
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
    db: parsed.pathname ? parseInt(parsed.pathname.slice(1) || '0', 10) : 0,
  };
}

function makeBaseOptions(): QueueOptions {
  return {
    connection: parseRedisUrl(config.redis.url),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  };
}

function makeCriticalOptions(): QueueOptions {
  return {
    connection: parseRedisUrl(config.redis.url),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
      priority: 10,
    },
  };
}

let _queues: {
  cacheWarmup: Queue<CacheWarmupData>;
  metrics: Queue<MetricsData>;
  asyncCritical: Queue<AuditLogJobData>;
  asyncPipeline: Queue<AnalyticsJobData | PipelineMetricsJobData>;
  webhookRetry: Queue<WebhookRetryData>;
  all: Queue[];
} | null = null;

function getQueues() {
  if (!_queues) {
    const opts = makeBaseOptions();
    const criticalOpts = makeCriticalOptions();
    const cacheWarmup = new Queue<CacheWarmupData>('cache-warmup', opts);
    const metrics = new Queue<MetricsData>('metrics-compute', opts);
    const asyncCritical = new Queue<AuditLogJobData>('async-critical', criticalOpts);
    const asyncPipeline = new Queue<AnalyticsJobData | PipelineMetricsJobData>('async-pipeline', opts);
    const webhookRetry = new Queue<WebhookRetryData>('webhook-retry', {
      connection: parseRedisUrl(config.redis.url),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'fixed', delay: 10_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    });
    _queues = {
      cacheWarmup,
      metrics,
      asyncCritical,
      asyncPipeline,
      webhookRetry,
      all: [cacheWarmup, metrics, asyncCritical, asyncPipeline, webhookRetry],
    };
  }
  return _queues;
}

export function getAllQueues(): Queue[] {
  return getQueues().all;
}

export async function closeQueues(): Promise<void> {
  const queues = getQueues();
  await Promise.all(queues.all.map(q => q.close()));
  _queues = null;
}

export async function scheduleRecurringJobs(): Promise<void> {
  const queues = getQueues();
  await queues.cacheWarmup.add('cache-warmup', { assets: [] }, { repeat: { every: 30_000 } });
  await queues.metrics.add('metrics-compute', { period: 'hourly' }, { repeat: { every: config.jobs.metricsIntervalMs } });
}

export async function enqueueAuditLog(data: AuditLogJobData): Promise<void> {
  const queues = getQueues();
  await queues.asyncCritical.add('async-audit-log', data);
}

export async function enqueueAnalytics(data: AnalyticsJobData): Promise<void> {
  const queues = getQueues();
  await queues.asyncPipeline.add('async-analytics', data);
}

export async function enqueuePipelineMetrics(data: PipelineMetricsJobData): Promise<void> {
  const queues = getQueues();
  await queues.asyncPipeline.add('pipeline-metrics', data);
}

export async function enqueueWebhookRetry(data: WebhookRetryData, delayMs: number): Promise<void> {
  const queues = getQueues();
  await queues.webhookRetry.add('webhook-retry', data, { delay: delayMs });
}

/** Returns the number of waiting (not yet picked up) jobs in a queue. */
export async function getQueueWaitingCount(queueName: 'async-critical' | 'async-pipeline'): Promise<number> {
  const queues = getQueues();
  const queue = queueName === 'async-critical' ? queues.asyncCritical : queues.asyncPipeline;
  return queue.count();
}
