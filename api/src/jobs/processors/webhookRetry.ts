import { Job } from 'bullmq';
import { WebhookRetryData } from '../queue';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const DELIVERY_TIMEOUT_MS = 10_000;

export async function processWebhookRetry(job: Job<WebhookRetryData>): Promise<void> {
  const { registrationId, payload, event, attemptNumber } = job.data;
  logger.info({ registrationId, event, attemptNumber }, 'retrying webhook delivery');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    const response = await fetch(registrationId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, payload }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`webhook returned ${response.status}`);
    }

    logger.info({ registrationId, event, status: response.status }, 'webhook retry delivered');
  } finally {
    clearTimeout(timer);
  }
}
