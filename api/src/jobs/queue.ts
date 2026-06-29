import { Queue, QueueOptions } from 'bullmq';
import { config } from '../config';

export type JobName =
  | 'tx-status-poll'
  | 'webhook-retry'
  | 'cache-warmup'
  | 'metrics-compute'
  | 'cleanup';

export interface TxStatusPollData {
  txHash: string;
  registrationId?: string;
}

export interface WebhookRetryData {
  registrationId: string;
  payload: unknown;
  event: string;
  attemptNumber: number;
}

export interface CacheWarmupData {
  assets: string[];
}

export interface MetricsData {
  period: 'hourly' | 'daily';
}

export interface CleanupData {
  olderThanMs: number;
}

export type JobData =
  | TxStatusPollData
  | WebhookRetryData
  | CacheWarmupData
  | MetricsData
  | CleanupData;

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

let _queues: {
  txStatus: Queue<TxStatusPollData>;
  webhookRetry: Queue<WebhookRetryData>;
  cacheWarmup: Queue<CacheWarmupData>;
  metrics: Queue<MetricsData>;
  cleanup: Queue<CleanupData>;
  all: Queue[];
} | null = null;

function getQueues() {
  if (!_queues) {
    const opts = makeBaseOptions();
    const txStatus = new Queue<TxStatusPollData>('tx-status-poll', opts);
    const webhookRetry = new Queue<WebhookRetryData>('webhook-retry', opts);
    const cacheWarmup = new Queue<CacheWarmupData>('cache-warmup', opts);
    const metrics = new Queue<MetricsData>('metrics-compute', opts);
    const cleanup = new Queue<CleanupData>('cleanup', opts);
    _queues = { txStatus, webhookRetry, cacheWarmup, metrics, cleanup, all: [txStatus, webhookRetry, cacheWarmup, metrics, cleanup] };
  }
  return _queues;
}

export function getAllQueues(): Queue[] {
  return getQueues().all;
}

export async function closeQueues(): Promise<void> {
  if (_queues) {
    await Promise.all(_queues.all.map((q) => q.close()));
    _queues = null;
  }
}

export async function scheduleRecurringJobs(): Promise<void> {
  const q = getQueues();
  await q.metrics.add('metrics-compute', { period: 'hourly' }, { repeat: { every: config.jobs.metricsIntervalMs } });
  await q.cleanup.add('cleanup', { olderThanMs: 7 * 24 * 60 * 60 * 1000 }, { repeat: { every: config.jobs.cleanupIntervalMs } });
  await q.cacheWarmup.add('cache-warmup', { assets: ['XLM', 'USDC'] }, { repeat: { every: 5 * 60 * 1000 } });
}

export async function enqueueTxStatusPoll(txHash: string): Promise<void> {
  await getQueues().txStatus.add('tx-status-poll', { txHash }, {
    delay: config.jobs.txPollIntervalMs,
    jobId: `tx-${txHash}`,
  });
}

export async function enqueueWebhookRetry(data: WebhookRetryData): Promise<void> {
  const delayMs = Math.min(5000 * Math.pow(2, data.attemptNumber - 1), 300_000);
  await getQueues().webhookRetry.add('webhook-retry', data, { delay: delayMs });
}
