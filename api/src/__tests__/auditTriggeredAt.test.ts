/**
 * #1054: an audit entry that goes through the async pipeline is stamped with
 * the time the event was triggered, not the time the worker processed it.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';

process.env.NODE_ENV = 'test';

vi.mock('../services/metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/metrics')>()),
  asyncPipelineJobDuration: { startTimer: vi.fn(() => vi.fn()) },
  asyncPipelineFailureCounter: { inc: vi.fn() },
}));

import { processAuditLog } from '../jobs/processors/asyncAuditLog';
import { integrityAuditLog } from '../services/auditLog';
import type { AuditLogJobData } from '../jobs/queue';

const SEVEN_YEARS_MS = 7 * 365 * 24 * 60 * 60 * 1000;

function job(data: AuditLogJobData): Job<AuditLogJobData> {
  return { id: 'job-1', data } as Job<AuditLogJobData>;
}

describe('processAuditLog keeps triggeredAt (#1054)', () => {
  it('stores the entry with timestamp === triggeredAt, even 60 s late', async () => {
    const triggeredAt = Date.now() - 60_000;
    await processAuditLog(job({ type: 'admin_operation', payload: { op: 'pause' }, actor: 'admin-1', triggeredAt }));

    const entry = integrityAuditLog.listEntries({ limit: 1000 }).at(-1)!;
    expect(entry.actor).toBe('admin-1');
    expect(entry.timestamp).toBe(triggeredAt);
    // Retention is measured from when the event happened, too.
    expect(entry.retentionUntil).toBe(triggeredAt + SEVEN_YEARS_MS);
  });

  it('falls back to now for a job enqueued without triggeredAt', async () => {
    const before = Date.now();
    await processAuditLog(
      job({ type: 'admin_operation', payload: {}, actor: 'legacy' } as unknown as AuditLogJobData),
    );
    const entry = integrityAuditLog.listEntries({ limit: 1000 }).at(-1)!;
    expect(entry.actor).toBe('legacy');
    expect(entry.timestamp).toBeGreaterThanOrEqual(before);
    expect(Number.isFinite(entry.retentionUntil)).toBe(true);
  });

  it('append() without a timestamp still stamps now', () => {
    const before = Date.now();
    const entry = integrityAuditLog.append('admin_operation', {}, 'direct');
    expect(entry.timestamp).toBeGreaterThanOrEqual(before);
    expect(entry.timestamp).toBeLessThanOrEqual(Date.now());
  });
});
