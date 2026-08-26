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
  throw new Error('Not implemented: processWebhookRetry');
}
