import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Job } from 'bullmq';
import type { WebhookRetryData } from '../../jobs/queue';
import { computeWebhookSignature } from '../../services/webhookSignature';

process.env.NODE_ENV = 'test';

const TEST_SECRET = 'whk-test-secret-do-not-use-in-prod';
const TEST_WEBHOOK_ID = 'whk-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const DEFAULT_REGISTRATION_ROW = {
  url: 'https://example.com/webhook',
  active: true,
  secret: TEST_SECRET,
};

const { enqueueWebhookRetry, query, getPool, logger } = vi.hoisted(() => {
  const query = vi.fn().mockResolvedValue({
    rows: [{ url: 'https://example.com/webhook', active: true, secret: 'whk-test-secret-do-not-use-in-prod' }],
  });
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
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn() };
});

import { processWebhookRetry } from '../../jobs/processors/webhookRetry';
import { lookup } from 'node:dns/promises';

// Issue #1061: the retry job carries payload + webhookId only. Signature and
// timestamp are recomputed in the worker so late retries stay inside the
// receiver's replay window.
function makeJob(overrides: Partial<WebhookRetryData> = {}): Job<WebhookRetryData> {
  return {
    id: 'webhook-retry-job-1',
    data: {
      registrationId: 'webhook-reg-123',
      deliveryId: 'delivery-abc',
      url: 'https://example.com/webhook',
      event: 'funding.submitted',
      webhookId: TEST_WEBHOOK_ID,
      payload: JSON.stringify({ txId: 'tx-456' }),
      data: { txId: 'tx-456' },
      attemptNumber: 1,
      ...overrides,
    },
  } as Job<WebhookRetryData>;
}

function isDlqInsert(call: unknown[]): boolean {
  return typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO webhook_dlq');
}

describe('processWebhookRetry', () => {
  let nowSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
    getPool.mockReturnValue({ query } as never);
    query.mockResolvedValue({ rows: [{ ...DEFAULT_REGISTRATION_ROW }] } as never);
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  });

  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = undefined;
  });

  it('looks up url + secret, then delivers with a freshly signed body', async () => {
    const fixedNow = 1_705_320_000_000;
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    const expectedTs = Math.floor(fixedNow / 1000);
    const payload = JSON.stringify({ txId: 'tx-456' });
    const expectedSig = computeWebhookSignature(TEST_SECRET, expectedTs, payload);

    query.mockResolvedValueOnce({
      rows: [{ url: 'https://example.com/webhook', active: true, secret: TEST_SECRET }],
    } as never);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, status: 200 });

    await processWebhookRetry(makeJob({ payload }));

    // The retry worker re-reads url, secret and active before every attempt.
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT url, secret, active FROM webhook_registrations'),
      ['webhook-reg-123'],
    );

    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://example.com/webhook');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe(payload);
    expect(opts.redirect).toBe('error');

    // Canonical headers - signature and timestamp are freshly computed.
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers['X-Webhook-Signature']).toBe(`sha256=${expectedSig}`);
    expect(opts.headers['X-Webhook-Timestamp']).toBe(String(expectedTs));
    expect(opts.headers['X-Webhook-Event']).toBe('funding.submitted');
    expect(opts.headers['X-Webhook-Attempt']).toBe('2');
    // Issue #1061: stable dedupe key from the job.
    expect(opts.headers['X-Webhook-Id']).toBe(TEST_WEBHOOK_ID);

    expect(enqueueWebhookRetry).not.toHaveBeenCalled();
  });

  it('re-signs with a FRESH timestamp on retry even 6 minutes after the first attempt', async () => {
    // First attempt was ~6 minutes ago. If we reused its timestamp the retry
    // would land outside the 300 s replay window - this test proves we don't.
    const t0Ms = 1_705_320_000_000;
    const retryMs = t0Ms + 6 * 60 * 1000;
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(retryMs);
    const retryTs = Math.floor(retryMs / 1000);
    const firstAttemptTs = Math.floor(t0Ms / 1000);

    const payload = JSON.stringify({ txId: 'tx-456' });
    const freshSig = computeWebhookSignature(TEST_SECRET, retryTs, payload);
    const staleSig = computeWebhookSignature(TEST_SECRET, firstAttemptTs, payload);

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, status: 200 });

    await processWebhookRetry(makeJob({ attemptNumber: 3, payload }));

    const [, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = opts.headers as Record<string, string>;

    // Timestamp is "now", not the original attempt time.
    expect(headers['X-Webhook-Timestamp']).toBe(String(retryTs));
    expect(headers['X-Webhook-Timestamp']).not.toBe(String(firstAttemptTs));

    // Signature verifies against the fresh timestamp, not the stale one.
    expect(headers['X-Webhook-Signature']).toBe(`sha256=${freshSig}`);
    expect(headers['X-Webhook-Signature']).not.toBe(`sha256=${staleSig}`);
  });

  it('carries the same deliveryId into the next attempt (#1057)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500 });

    await processWebhookRetry(makeJob({ attemptNumber: 1 }));

    expect(enqueueWebhookRetry).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'delivery-abc', attemptNumber: 2 }),
      60_000,
    );
  });

  it('re-enqueues the next attempt with the next delay on failure', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500 });

    await processWebhookRetry(makeJob({ attemptNumber: 1 }));

    expect(enqueueWebhookRetry).toHaveBeenCalledWith(
      expect.objectContaining({ registrationId: 'webhook-reg-123', attemptNumber: 2 }),
      60_000,
    );
  });

  it('re-enqueues when fetch throws', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ECONNRESET'));

    await processWebhookRetry(makeJob({ attemptNumber: 2 }));

    expect(enqueueWebhookRetry).toHaveBeenCalledWith(expect.objectContaining({ attemptNumber: 3 }), 300_000);
  });

  it('writes a DLQ entry (with attempts and last_error) after the last attempt', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 503 });

    await processWebhookRetry(makeJob({ attemptNumber: 3 }));

    expect(enqueueWebhookRetry).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_dlq'),
      [expect.any(String), 'webhook-reg-123', 'funding.submitted', JSON.stringify({ txId: 'tx-456' }), 4, 'HTTP 503'],
    );
  });

  it('drops the retry when no database is configured (cannot re-sign)', async () => {
    // Issue #1061: without the secret we cannot produce a valid signature,
    // so dropping is the safe path. The delivery must not fire.
    getPool.mockReturnValue(null as never);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, status: 200 });

    await processWebhookRetry(makeJob({ attemptNumber: 1 }));

    expect(global.fetch).not.toHaveBeenCalled();
    expect(enqueueWebhookRetry).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ registrationId: 'webhook-reg-123' }),
      expect.stringContaining('no database configured'),
    );
  });

  it('moves to DLQ with a blocked-address error when the retry URL resolves to 10.0.0.5', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never);

    await processWebhookRetry(makeJob({ attemptNumber: 1 }));

    expect(global.fetch).not.toHaveBeenCalled();
    expect(enqueueWebhookRetry).not.toHaveBeenCalled();

    const dlqInserts = (query.mock.calls as unknown[][]).filter(isDlqInsert);
    expect(dlqInserts).toHaveLength(1);
    const args = dlqInserts[0][1] as unknown[];
    expect(args[1]).toBe('webhook-reg-123');
    expect(args[2]).toBe('funding.submitted');
    expect(args[4]).toBe(2);
    expect(String(args[5])).toMatch(/blocked address/i);
    expect(String(args[5])).toMatch(/non-public/i);
  });

  it('drops the retry when the registration was deleted', async () => {
    query.mockResolvedValueOnce({ rows: [] } as never);

    await processWebhookRetry(makeJob({ attemptNumber: 1 }));

    expect(global.fetch).not.toHaveBeenCalled();
    expect(enqueueWebhookRetry).not.toHaveBeenCalled();
    const dlqInserts = (query.mock.calls as unknown[][]).filter(isDlqInsert);
    expect(dlqInserts).toHaveLength(0);
  });

  it('drops the retry when the registration is inactive', async () => {
    query.mockResolvedValueOnce({
      rows: [{ url: 'https://example.com/webhook', active: false, secret: TEST_SECRET }],
    } as never);

    await processWebhookRetry(makeJob({ attemptNumber: 1 }));

    expect(global.fetch).not.toHaveBeenCalled();
    expect(enqueueWebhookRetry).not.toHaveBeenCalled();
  });

  it('drops the retry when the registration URL changed', async () => {
    query.mockResolvedValueOnce({
      rows: [{ url: 'https://new.example.com/hook', active: true, secret: TEST_SECRET }],
    } as never);

    await processWebhookRetry(makeJob({ attemptNumber: 1 }));

    expect(global.fetch).not.toHaveBeenCalled();
    expect(enqueueWebhookRetry).not.toHaveBeenCalled();
  });
});
