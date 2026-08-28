import { Job } from 'bullmq';
import { MetricsData } from '../queue';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

interface MetricsSnapshot {
  period: 'hourly' | 'daily';
  computedAt: number;
  txSubmitted: number;
  txSuccess: number;
  txFailed: number;
  webhooksDelivered: number;
}

const metricsStore: MetricsSnapshot[] = [];

export function recordMetric(key: keyof Omit<MetricsSnapshot, 'period' | 'computedAt'>): void {
  pendingSnapshot[key]++;
}

let pendingSnapshot: Omit<MetricsSnapshot, 'period' | 'computedAt'> = resetCounters();

function resetCounters() {
  return { txSubmitted: 0, txSuccess: 0, txFailed: 0, webhooksDelivered: 0 };
}

function getPendingSnapshot() {
  return pendingSnapshot;
}

export async function processMetrics(job: Job<MetricsData>): Promise<void> {
  const snapshot: MetricsSnapshot = {
    period: job.data.period,
    computedAt: Date.now(),
    ...pendingSnapshot,
  };
  metricsStore.push(snapshot);
  logger.info({ period: job.data.period }, 'Metrics snapshot captured');
  pendingSnapshot = resetCounters();
}

export function getMetrics(): MetricsSnapshot[] {
  return metricsStore;
}
