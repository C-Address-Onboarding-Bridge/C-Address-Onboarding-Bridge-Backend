import { Queue, QueueOptions } from 'bullmq';
import { config } from '../config';

export type JobName =
  | 'cache-warmup'
  | 'metrics-compute'
  | 'cleanup'
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

export interface CleanupData {
  olderThanMs: number;
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

export interface WebhookRetryData {
  registrationId: string;
  event: string;
  payload: string;
  signature: string;
  data: unknown;
  attemptNumber: number;
}

export type JobData =
  | CacheWarmupData
  | MetricsData
  | CleanupData
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
  cleanup: Queue<CleanupData>;
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
    const cleanup = new Queue<CleanupData>('cleanup', opts);
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
      cleanup,
      asyncCritical,
      asyncPipeline,
      webhookRetry,
      all: [cacheWarmup, metrics, cleanup, asyncCritical, asyncPipeline, webhookRetry],
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
  throw new Error('Not implemented: scheduleRecurringJobs');
}

export async function enqueueAuditLog(data: AuditLogJobData): Promise<void> {
  throw new Error('Not implemented: enqueueAuditLog');
}

export async function enqueueAnalytics(data: AnalyticsJobData): Promise<void> {
  throw new Error('Not implemented: enqueueAnalytics');
}

export async function enqueuePipelineMetrics(data: PipelineMetricsJobData): Promise<void> {
  const queues = getQueues();
  await queues.asyncPipeline.add('pipeline-metrics', data);
}

export async function enqueueWebhookRetry(data: WebhookRetryData): Promise<void> {
  const queues = getQueues();
  await queues.webhookRetry.add('webhook-retry', data);
}

/** Returns the number of waiting (not yet picked up) jobs in a queue. */
export async function getQueueWaitingCount(queueName: 'async-critical' | 'async-pipeline'): Promise<number> {
  const queues = getQueues();
  const queue = queueName === 'async-critical' ? queues.asyncCritical : queues.asyncPipeline;
  return queue.count();
}
