import { Worker, WorkerOptions } from 'bullmq';
import pino from 'pino';
import { config } from '../config';
import { getAllQueues, closeQueues } from './queue';
import { processTxStatusPoll } from './processors/txStatus';
import { processWebhookRetry } from './processors/webhookRetry';
import { processCacheWarmup } from './processors/cacheWarmup';
import { processMetrics } from './processors/metrics';
import { processCleanup } from './processors/cleanup';

const logger = pino({ level: config.logLevel });

function parseRedisUrl(url: string): { host: string; port: number; password?: string; db?: number } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || 'localhost',
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
    db: parsed.pathname ? parseInt(parsed.pathname.slice(1) || '0', 10) : 0,
  };
}

function makeWorkerOptions(concurrency: number): WorkerOptions {
  return { connection: parseRedisUrl(config.redis.url), concurrency };
}

export function startWorkers(): Worker[] {
  const workers: Worker[] = [
    new Worker('tx-status-poll', processTxStatusPoll, makeWorkerOptions(config.jobs.concurrency.txStatus)),
    new Worker('webhook-retry', processWebhookRetry, makeWorkerOptions(config.jobs.concurrency.webhookRetry)),
    new Worker('cache-warmup', processCacheWarmup, makeWorkerOptions(config.jobs.concurrency.cacheWarmup)),
    new Worker('metrics-compute', processMetrics, makeWorkerOptions(config.jobs.concurrency.metrics)),
    new Worker('cleanup', processCleanup, makeWorkerOptions(config.jobs.concurrency.cleanup)),
  ];

  for (const worker of workers) {
    worker.on('completed', (job) => {
      logger.info({ jobId: job.id, queue: job.queueName }, 'job completed');
    });
    worker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, queue: job?.queueName, err }, 'job failed');
    });
    worker.on('error', (err) => {
      logger.error({ err }, 'worker error');
    });
  }

  logger.info({ count: workers.length }, 'workers started');
  return workers;
}

export async function stopWorkers(workers: Worker[]): Promise<void> {
  logger.info('stopping workers');
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  logger.info('workers stopped');
}

// Standalone worker entry point
if (require.main === module) {
  const workers = startWorkers();

  const shutdown = async () => {
    await stopWorkers(workers);
    process.exit(0);
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
