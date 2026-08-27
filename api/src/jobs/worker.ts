import { Worker, WorkerOptions } from 'bullmq';
import pino from 'pino';
import { config } from '../config';
import { closeQueues } from './queue';
import { processCacheWarmup } from './processors/cacheWarmup';
import { processMetrics } from './processors/metrics';
import { processCleanup } from './processors/cleanup';
import { processAuditLog } from './processors/asyncAuditLog';
import { processAsyncPipeline } from './processors/asyncPipeline';
import { processWebhookRetry } from './processors/webhookRetry';

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
  const workers: Worker[] = [];

  workers.push(
    new Worker('cache-warmup', processCacheWarmup, makeWorkerOptions(2)),
    new Worker('metrics-compute', processMetrics, makeWorkerOptions(1)),
    new Worker('cleanup', processCleanup, makeWorkerOptions(1)),
    new Worker('async-critical', processAuditLog, makeWorkerOptions(5)),
    new Worker('async-pipeline', processAsyncPipeline, makeWorkerOptions(10)),
    new Worker('webhook-retry', processWebhookRetry, makeWorkerOptions(3)),
  );

  workers.forEach(worker => {
    worker.on('completed', (job) => {
      logger.debug({ jobId: job.id, queueName: job.queueName }, 'Job completed');
    });
    worker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, queueName: job?.queueName, error: err.message }, 'Job failed');
    });
  });

  return workers;
}

export async function stopWorkers(workers: Worker[]): Promise<void> {
  await Promise.all(workers.map(worker => worker.close()));
  await closeQueues();
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
