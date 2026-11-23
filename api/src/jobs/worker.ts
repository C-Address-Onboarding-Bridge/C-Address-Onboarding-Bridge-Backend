import { Worker, WorkerOptions } from 'bullmq';
import pino from 'pino';
import { config } from '../config';
import { closeQueues, scheduleRecurringJobs } from './queue';
import { createRedisConnection } from './connection';
import { processCacheWarmup } from './processors/cacheWarmup';
import { processMetrics } from './processors/metrics';
import { processAuditLog } from './processors/asyncAuditLog';
import { processAsyncPipeline } from './processors/asyncPipeline';
import { processWebhookRetry } from './processors/webhookRetry';

const logger = pino({ level: config.logLevel });

// #1051: `parseRedisUrl` used to live here too. Workers now use the same
// shared ioredis factory as Queue, so `rediss://`, ACL username, and db are
// all handled by ioredis' own URL parser.
function makeWorkerOptions(concurrency: number): WorkerOptions {
  return { connection: createRedisConnection(), concurrency };
}

/**
 * Instantiates all BullMQ workers.
 *
 * #1050: concurrency is now read from `config.jobs.concurrency.*` instead of
 * being hard-coded, so operators can tune queue throughput without a rebuild.
 */
export function startWorkers(): Worker[] {
  const workers: Worker[] = [];

  workers.push(
    new Worker('cache-warmup', processCacheWarmup, makeWorkerOptions(config.jobs.concurrency.cacheWarmup)),
    new Worker('metrics-compute', processMetrics, makeWorkerOptions(config.jobs.concurrency.metrics)),
    new Worker('async-critical', processAuditLog, makeWorkerOptions(config.jobs.concurrency.asyncCritical)),
    new Worker('async-pipeline', processAsyncPipeline, makeWorkerOptions(config.jobs.concurrency.asyncPipeline)),
    new Worker('webhook-retry', processWebhookRetry, makeWorkerOptions(config.jobs.concurrency.webhookRetry)),
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
  await Promise.all(workers.map((worker) => worker.close()));
  await closeQueues();
}

/**
 * Worker process entry point.
 *
 * #1050: this is now the single place that (a) schedules recurring jobs once,
 * (b) starts every BullMQ worker, and (c) wires graceful shutdown. It is
 * invoked from the `worker` service in docker-compose.yml via
 * `node api/dist/jobs/worker.js`.
 */
export async function main(): Promise<void> {
  if (!config.jobs.enabled) {
    logger.warn('jobs disabled (JOBS_ENABLED=false or REDIS_URL unset); worker exiting');
    return;
  }

  // Idempotent: stable repeat keys prevent duplicate schedules across restarts.
  await scheduleRecurringJobs();
  logger.info('recurring jobs scheduled');

  const workers = startWorkers();
  logger.info({ workerCount: workers.length }, 'bullmq workers started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    try {
      await stopWorkers(workers);
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

// Standalone worker entry point
if (require.main === module) {
  void main().catch((err) => {
    logger.error({ err }, 'worker failed to start');
    process.exit(1);
  });
}
