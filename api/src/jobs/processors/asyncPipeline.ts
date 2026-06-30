import { Job } from 'bullmq';
import type { AnalyticsJobData, PipelineMetricsJobData } from '../queue';
import { recordFundingMetrics, type FundingMetricInput } from '../../services/metrics';
import { asyncPipelineJobDuration, asyncPipelineFailureCounter } from '../../services/metrics';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

type PipelineJobData = AnalyticsJobData | PipelineMetricsJobData;

export async function processAsyncPipeline(job: Job<PipelineJobData>): Promise<void> {
  const jobName = job.name as 'async-analytics' | 'async-metrics';
  const end = asyncPipelineJobDuration.startTimer({ queue: 'async-pipeline', job: jobName });

  try {
    if (jobName === 'async-analytics') {
      await processAnalytics(job as Job<AnalyticsJobData>);
    } else if (jobName === 'async-metrics') {
      await processPipelineMetrics(job as Job<PipelineMetricsJobData>);
    } else {
      logger.warn({ jobId: job.id, jobName }, 'unknown async-pipeline job name — skipping');
    }
  } catch (err) {
    asyncPipelineFailureCounter.inc({ queue: 'async-pipeline', job: jobName });
    logger.error({ jobId: job.id, jobName, err }, 'async-pipeline processor failed');
    throw err;
  } finally {
    end();
  }
}

async function processAnalytics(job: Job<AnalyticsJobData>): Promise<void> {
  const { batch } = job.data;
  logger.debug({ jobId: job.id, batchSize: batch.length }, 'processing analytics batch');

  // Analytics counters are Prometheus-only in this implementation.
  // The batch is already accumulated in-process; flushing here is a no-op for
  // Prometheus (counters were incremented synchronously before enqueue), but
  // this processor is the correct place to forward batches to external
  // analytics backends (e.g. Segment, Mixpanel) if needed in the future.
  //
  // Currently: log the batch for observability.
  for (const entry of batch) {
    logger.debug({ event: entry.event, labels: entry.labels, value: entry.value }, 'analytics event');
  }
}

async function processPipelineMetrics(job: Job<PipelineMetricsJobData>): Promise<void> {
  const { operation, data } = job.data;

  if (operation === 'funding') {
    recordFundingMetrics(data as unknown as FundingMetricInput);
    logger.debug({ jobId: job.id, operation }, 'funding metrics recorded async');
  } else {
    logger.debug({ jobId: job.id, operation }, 'pipeline metrics job processed');
  }
}
