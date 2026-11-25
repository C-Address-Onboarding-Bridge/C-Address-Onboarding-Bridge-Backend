import { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { enqueueWebhookRetry, WEBHOOK_RETRY_DELAYS_MS, type WebhookRetryData } from '../queue';
import { getPool } from '../../services/db';
import { logger } from '../../logger';
import { BlockedAddressError, safeWebhookFetch } from '../../services/webhookSecurity';
import {
  buildWebhookHeaders,
  computeWebhookSignature,
  toUnixSeconds,
} from '../../services/webhookSignature';

const DELIVERY_TIMEOUT_MS = 10_000;

interface ActiveRegistration {
  url: string;
  secret: string;
}

/**
 * Load the current registration for a retry job.
 *
 * Returns null when the retry MUST be dropped:
 * - no database is configured (we cannot look up the secret to re-sign);
 * - the registration has been deleted (user unregistered the webhook);
 * - the registration is inactive (auto-disabled after repeated failures);
 * - the DB lookup threw (we cannot sign without the secret, so proceeding
 *   would emit an invalid request).
 *
 * Issues #1059 and #1061 both live here: #1059 drops retries whose target is
 * gone; #1061 re-reads the secret at send time so every attempt can be signed
 * with a fresh timestamp.
 */
async function loadActiveRegistration(registrationId: string): Promise<ActiveRegistration | null> {
  const pool = getPool();
  if (!pool) {
    logger.error(
      { registrationId },
      'webhook retry dropped: no database configured (cannot look up secret to re-sign)',
    );
    return null;
  }
  try {
    const { rows } = await pool.query<{ url: string; secret: string; active: boolean }>(
      `SELECT url, secret, active FROM webhook_registrations WHERE id = $1`,
      [registrationId],
    );
    const row = rows[0];
    if (!row) {
      logger.info({ registrationId }, 'webhook retry dropped: registration not found');
      return null;
    }
    if (!row.active) {
      logger.info({ registrationId }, 'webhook retry dropped: registration inactive');
      return null;
    }
    return { url: row.url, secret: row.secret };
  } catch (err) {
    logger.warn(
      { registrationId, err: err instanceof Error ? err.message : String(err) },
      'webhook retry dropped: registration lookup failed (cannot safely re-sign)',
    );
    return null;
  }
}

/**
 * Webhook retry job processor.
 *
 * Runs in the worker process, which has no access to the API's in-memory
 * registrations, so everything needed to *address* the delivery is carried
 * in the job (registrationId, url, event, webhookId, payload).
 *
 * Issue #1061: the signature and timestamp are NOT carried in the job.
 * Every attempt re-fetches the registration secret and re-signs
 * HMAC-SHA256(secret, `${nowSeconds}.${payload}`). This keeps late retries
 * (up to ~370 s after the first attempt) inside the documented 300 s replay
 * window and lets receivers verify with a single rule.
 *
 * Issue #1059: the SSRF-safe fetch (pinned lookup, refuse redirects) applies
 * on every retry, and the registration is re-checked so retries for
 * deleted / deactivated registrations never fire.
 */
export async function processWebhookRetry(job: Job<WebhookRetryData>): Promise<void> {
  const {
    registrationId,
    url,
    event,
    webhookId: maybeWebhookId,
    payload,
    attemptNumber,
  } = job.data;

  // Defensive: in-flight jobs enqueued before the #1061 deploy may lack the
  // webhookId field. Mint one so the header is still valid; dedupe for those
  // legacy jobs is best-effort.
  const webhookId = maybeWebhookId ?? randomUUID();

  const registration = await loadActiveRegistration(registrationId);
  if (registration === null) return;

  if (registration.url !== url) {
    logger.warn(
      { registrationId, jobUrl: url, registrationUrl: registration.url },
      'webhook retry dropped: registration URL changed since the job was enqueued',
    );
    return;
  }

  // Fresh timestamp + signature for THIS attempt (issue #1061).
  const timestampSeconds = toUnixSeconds(Date.now());
  const signature = computeWebhookSignature(registration.secret, timestampSeconds, payload);

  let lastError: string;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      // SSRF-safe: resolve once, pin the answer, and refuse redirects.
      const response = await safeWebhookFetch(url, {
        method: 'POST',
        headers: buildWebhookHeaders({
          event,
          timestampSeconds,
          signatureHex: signature,
          attempt: attemptNumber + 1,
          webhookId,
        }),
        body: payload,
        signal: controller.signal,
      });

      if (response.ok) {
        logger.info(
          { registrationId, url, event, webhookId, attempt: attemptNumber + 1 },
          'webhook retry delivered successfully',
        );
        return;
      }

      lastError = `HTTP ${response.status}`;
      logger.warn(
        { registrationId, url, event, status: response.status, attempt: attemptNumber + 1 },
        'webhook retry delivery failed with non-2xx status',
      );
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    if (err instanceof BlockedAddressError) {
      // Retrying will not un-block the DNS answer, and a rebinding attacker
      // is actively trying to make us POST inside the network. Move straight
      // to the DLQ with the blocked-address reason recorded.
      lastError = `blocked address: ${err.message}`;
      logger.warn(
        { registrationId, url, event, error: lastError, attempt: attemptNumber + 1 },
        'webhook retry blocked: URL resolves to a non-public address',
      );
      await writeDlqEntry(job.data, lastError);
      return;
    }

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
  // Schema (see WebhookDeliveryRepository.init) uses `attempts` and `last_error`;
  // there is no `failed_at` column, so the insert must match the table.
  await pool.query(
    `INSERT INTO webhook_dlq (id, registration_id, event, payload, attempts, last_error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, registrationId, event, payload, attemptNumber + 1, lastError],
  );
  logger.error(
    { registrationId, url, event, attempt: attemptNumber + 1, error: lastError, dlqId: id },
    'webhook retry exhausted, moved to DLQ',
  );
}
