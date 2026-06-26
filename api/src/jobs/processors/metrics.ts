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
  // Increment counters in the pending snapshot
  const pending = getPendingSnapshot();
  if (key in pending) {
    (pending[key] as number)++;
  }
}

let pendingSnapshot: Omit<MetricsSnapshot, 'period' | 'computedAt'> = resetCounters();

function resetCounters() {
  return { txSubmitted: 0, txSuccess: 0, txFailed: 0, webhooksDelivered: 0 };
}

function getPendingSnapshot() {
  return pendingSnapshot;
}

export async function processMetrics(job: Job<MetricsData>): Promise<void> {
  const { period } = job.data;
  const snapshot: MetricsSnapshot = { period, computedAt: Date.now(), ...pendingSnapshot };
  metricsStore.push(snapshot);
  pendingSnapshot = resetCounters();

  logger.info({ period, snapshot }, 'metrics snapshot computed');

  // Keep last 30 snapshots
  if (metricsStore.length > 30) metricsStore.splice(0, metricsStore.length - 30);
}

export function getMetrics(): MetricsSnapshot[] {
  return metricsStore.slice();
}
