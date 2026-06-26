import { Job } from 'bullmq';
import { CleanupData } from '../queue';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// In-process idempotency key store (in production, use Redis or DB)
const idempotencyKeys = new Map<string, { usedAt: number }>();

export function registerIdempotencyKey(key: string): void {
  idempotencyKeys.set(key, { usedAt: Date.now() });
}

export function isIdempotencyKeyUsed(key: string): boolean {
  return idempotencyKeys.has(key);
}

export async function processCleanup(job: Job<CleanupData>): Promise<void> {
  const { olderThanMs } = job.data;
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;

  for (const [key, meta] of idempotencyKeys.entries()) {
    if (meta.usedAt < cutoff) {
      idempotencyKeys.delete(key);
      removed++;
    }
  }

  logger.info({ removed, cutoffMs: olderThanMs }, 'cleanup complete');
}
