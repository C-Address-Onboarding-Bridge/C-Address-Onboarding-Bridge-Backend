import { Job } from 'bullmq';
import type { WebhookRetryData } from '../queue';
import { webhookDeliveryService } from '../../services/webhookDelivery';
import { logger } from '../../index';

const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Webhook retry job processor.
 * Retries failed webhook deliveries via the webhook-retry queue instead of setTimeout.
 * This ensures retries survive process restarts/deploys and reach the DLQ on final failure.
 */
export async function processWebhookRetry(job: Job<WebhookRetryData>): Promise<void> {
  const { registrationId, event, payload, signature, data, attemptNumber } = job.data;
  const registration = webhookDeliveryService.getRegistration(registrationId);

  if (!registration) {
    logger.warn({ registrationId, event }, 'webhook registration not found, abandoning retry');
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    const response = await fetch(registration.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${signature}`,
        'X-Webhook-Event': event,
        'X-Webhook-Attempt': String(attemptNumber + 1),
      },
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      logger.info(
        { registrationId, url: registration.url, event, attempt: attemptNumber + 1 },
        'webhook retry delivered successfully',
      );
      return;
    }

    logger.warn(
      { registrationId, url: registration.url, event, status: response.status, attempt: attemptNumber + 1 },
      'webhook retry delivery failed with non-2xx status',
    );
  } catch (err) {
    logger.warn(
      { registrationId, url: registration.url, event, error: err instanceof Error ? err.message : String(err), attempt: attemptNumber + 1 },
      'webhook retry delivery error',
    );
  }

  if (attemptNumber >= 2) {
    logger.error(
      { registrationId, event, attempt: attemptNumber + 1 },
      'webhook retry exhausted, moving to DLQ',
    );
  }
}
