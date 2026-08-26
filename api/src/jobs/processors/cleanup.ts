import { Job } from 'bullmq';
import { CleanupData } from '../queue';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// In-process idempotency key store (in production, use Redis or DB)
const idempotencyKeys = new Map<string, { usedAt: number }>();

export function registerIdempotencyKey(key: string): void {
  throw new Error('Not implemented: registerIdempotencyKey');
}

export function isIdempotencyKeyUsed(key: string): boolean {
  throw new Error('Not implemented: isIdempotencyKeyUsed');
}

export async function processCleanup(job: Job<CleanupData>): Promise<void> {
  throw new Error('Not implemented: processCleanup');
}
