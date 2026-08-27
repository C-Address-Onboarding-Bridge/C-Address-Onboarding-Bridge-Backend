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
  const now = Date.now();
  const olderThanMs = job.data.olderThanMs;

  for (const [key, data] of idempotencyKeys.entries()) {
    if (now - data.usedAt > olderThanMs) {
      idempotencyKeys.delete(key);
    }
  }

  logger.info({ olderThanMs }, 'Cleanup completed');
}
