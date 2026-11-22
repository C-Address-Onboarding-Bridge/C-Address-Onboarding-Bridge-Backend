import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Job } from 'bullmq';
import type { WebhookRetryData } from '../../jobs/queue';

process.env.NODE_ENV = 'test';

const { enqueueWebhookRetry, query, getPool, logger } = vi.hoisted(() => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return {
    enqueueWebhookRetry: vi.fn().mockResolvedValue(undefined),
    query,
    getPool: vi.fn(() => ({ query })),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('../../jobs/queue', () => ({
  WEBHOOK_RETRY_DELAYS_MS: [10_000, 60_000, 300_000],
  enqueueWebhookRetry,
}));
vi.mock('../../services/db', () => ({ getPool }));
vi.mock('../../logger', () => ({ logger }));

import { processWebhookRetry } from '../../jobs/processors/webhookRetry';

function makeJob(overrides: Partial<WebhookRetryData> = {}): Job<WebhookRetryData> {
  return {
    id: 'webhook-retry-job-1',
    data: {
      registrationId: 'webhook-reg-123',
      url: 'https://example.com/webhook',
      event: 'funding.submitted',
      timestamp: 1_700_000_000_000,
      payload: JSON.stringify({ txId: 'tx-456' }),
      signature: 'sig123',
      data: { txId: 'tx-456' },
      attemptNumber: 1,
      ...overrides,
    },
  } as Job<WebhookRetryData>;
}

describe('processWebhookRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('delivers using only the job data (no API-process registration lookup)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, status: 200 });

    await processWebhookRetry(makeJob());

    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ txId: 'tx-456' }),
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': 'sha256=sig123',
          'X-Webhook-Timestamp': '1700000000000',
          'X-Webhook-Event': 'funding.submitted',
          'X-Webhook-Attempt': '2',
        },
      }),
    );
    expect(enqueueWebhookRetry).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('re-enqueues the next attempt with the next delay on failure', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500 });

    await processWebhookRetry(makeJob({ attemptNumber: 1 }));

    expect(enqueueWebhookRetry).toHaveBeenCalledWith(
      expect.objectContaining({ registrationId: 'webhook-reg-123', attemptNumber: 2 }),
      60_000,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('re-enqueues when fetch throws', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ECONNRESET'));

    await processWebhookRetry(makeJob({ attemptNumber: 2 }));

    expect(enqueueWebhookRetry).toHaveBeenCalledWith(expect.objectContaining({ attemptNumber: 3 }), 300_000);
  });

  it('writes a DLQ entry after the last attempt instead of re-enqueueing', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 503 });

    await processWebhookRetry(makeJob({ attemptNumber: 3 }));

    expect(enqueueWebhookRetry).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_dlq'),
      [expect.any(String), 'webhook-reg-123', 'funding.submitted', JSON.stringify({ txId: 'tx-456' }), expect.any(Number)],
    );
  });

  it('logs an error when exhausted without a database', async () => {
    getPool.mockReturnValueOnce(null as never);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 503 });

    await processWebhookRetry(makeJob({ attemptNumber: 3 }));

    expect(enqueueWebhookRetry).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ registrationId: 'webhook-reg-123', error: 'HTTP 503' }),
      expect.stringContaining('DLQ entry not persisted'),
    );
  });
});
