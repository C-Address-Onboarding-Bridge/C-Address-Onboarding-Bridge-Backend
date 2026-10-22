import { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { enqueueWebhookRetry, WEBHOOK_RETRY_DELAYS_MS, type WebhookRetryData } from '../queue';
import { getPool } from '../../services/db';
import { logger } from '../../logger';

const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Webhook retry job processor.
 * Retries failed webhook deliveries via the webhook-retry queue instead of setTimeout.
 * This ensures retries survive process restarts/deploys and reach the DLQ on final failure.
 *
 * Runs in the worker process, which has no access to the API's in-memory
 * registrations, so everything needed for delivery is carried in the job.
 */
export async function processWebhookRetry(job: Job<WebhookRetryData>): Promise<void> {
  const { registrationId, url, event, timestamp, payload, signature, attemptNumber } = job.data;
  let lastError: string;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${signature}`,
        'X-Webhook-Timestamp': String(timestamp),
        'X-Webhook-Event': event,
        'X-Webhook-Attempt': String(attemptNumber + 1),
      },
      body: payload,
      signal: controller.signal,
      redirect: 'error',
    });

    clearTimeout(timeout);

    if (response.ok) {
      logger.info(
        { registrationId, url, event, attempt: attemptNumber + 1 },
        'webhook retry delivered successfully',
      );
      return;
    }

    lastError = `HTTP ${response.status}`;
    logger.warn(
      { registrationId, url, event, status: response.status, attempt: attemptNumber + 1 },
      'webhook retry delivery failed with non-2xx status',
    );
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.warn(
      { registrationId, url, event, error: lastError, attempt: attemptNumber + 1 },
      'webhook retry delivery error',
    );
  }

  if (attemptNumber < WEBHOOK_RETRY_DELAYS_MS.length) {
    const delay = WEBHOOK_RETRY_DELAYS_MS[attemptNumber];
    await enqueueWebhookRetry({ ...job.data, attemptNumber: attemptNumber + 1 }, delay);
    logger.info(
      { registrationId, event, nextAttemptIn: delay, attempt: attemptNumber + 1 },
      'scheduling webhook retry',
    );
    return;
  }

  await writeDlqEntry(job.data, lastError);
}

async function writeDlqEntry(data: WebhookRetryData, lastError: string): Promise<void> {
  const { registrationId, url, event, payload, attemptNumber } = data;
  const pool = getPool();
  if (!pool) {
    logger.error(
      { registrationId, url, event, attempt: attemptNumber + 1, error: lastError },
      'webhook retry exhausted but no database is configured; DLQ entry not persisted',
    );
    return;
  }

  const id = randomUUID();
  await pool.query(
    `INSERT INTO webhook_dlq (id, registration_id, event, payload, failed_at) VALUES ($1, $2, $3, $4, $5)`,
    [id, registrationId, event, payload, Date.now()],
  );
  logger.error(
    { registrationId, url, event, attempt: attemptNumber + 1, error: lastError, dlqId: id },
    'webhook retry exhausted, moved to DLQ',
  );
}
