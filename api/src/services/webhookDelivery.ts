import crypto from 'crypto';
import { logger } from '../index';

export interface WebhookRegistration {
  id: string;
  url: string;
  secret: string;
  apiKey: string;
  events: string[];
  createdAt: number;
}

export interface DeliveryAttempt {
  id: string;
  registrationId: string;
  webhookUrl: string;
  event: string;
  statusCode?: number;
  error?: string;
  timestamp: number;
  attemptNumber: number;
}

export interface DLQEntry {
  id: string;
  registration: WebhookRegistration;
  payload: unknown;
  event: string;
  attempts: DeliveryAttempt[];
  failedAt: number;
}

const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const DELIVERY_TIMEOUT_MS = 10_000;

export class WebhookDeliveryService {
  private registrations = new Map<string, WebhookRegistration>();
  private dlq: DLQEntry[] = [];
  private deliveryLog: DeliveryAttempt[] = [];

  register(params: { url: string; secret: string; apiKey: string; events: string[] }): WebhookRegistration {
    const registration: WebhookRegistration = {
      id: crypto.randomUUID(),
      url: params.url,
      secret: params.secret,
      apiKey: params.apiKey,
      events: params.events,
      createdAt: Date.now(),
    };
    this.registrations.set(registration.id, registration);
    logger.info({ registrationId: registration.id, url: params.url }, 'webhook registered');
    return registration;
  }

  unregister(id: string): boolean {
    return this.registrations.delete(id);
  }

  getRegistration(id: string): WebhookRegistration | undefined {
    return this.registrations.get(id);
  }

  getRegistrationsByApiKey(apiKey: string): WebhookRegistration[] {
    return [...this.registrations.values()].filter((r) => r.apiKey === apiKey);
  }

  sign(payload: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  async deliver(registration: WebhookRegistration, event: string, data: unknown): Promise<void> {
    const payload = JSON.stringify({ event, data, timestamp: Date.now() });
    const signature = this.sign(payload, registration.secret);

    await this.attemptDelivery(registration, event, data, payload, signature, 0);
  }

  async deliverToAll(apiKey: string, event: string, data: unknown): Promise<void> {
    const targets = this.getRegistrationsByApiKey(apiKey).filter(
      (r) => r.events.includes(event) || r.events.includes('*'),
    );
    await Promise.all(targets.map((r) => this.deliver(r, event, data)));
  }

  private async attemptDelivery(
    registration: WebhookRegistration,
    event: string,
    data: unknown,
    payload: string,
    signature: string,
    attemptNumber: number,
  ): Promise<void> {
    const attempt: DeliveryAttempt = {
      id: crypto.randomUUID(),
      registrationId: registration.id,
      webhookUrl: registration.url,
      event,
      timestamp: Date.now(),
      attemptNumber,
    };

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
      attempt.statusCode = response.status;

      if (response.ok) {
        logger.info(
          { registrationId: registration.id, url: registration.url, event, attempt: attemptNumber + 1 },
          'webhook delivered',
        );
        this.deliveryLog.push(attempt);
        return;
      }

      attempt.error = `HTTP ${response.status}`;
      logger.warn(
        { registrationId: registration.id, url: registration.url, event, status: response.status, attempt: attemptNumber + 1 },
        'webhook delivery failed with non-2xx status',
      );
    } catch (err) {
      attempt.error = err instanceof Error ? err.message : 'unknown error';
      logger.warn(
        { registrationId: registration.id, url: registration.url, event, error: attempt.error, attempt: attemptNumber + 1 },
        'webhook delivery error',
      );
    }

    this.deliveryLog.push(attempt);

    if (attemptNumber < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[attemptNumber];
      logger.info(
        { registrationId: registration.id, event, nextAttemptIn: delay, attempt: attemptNumber + 1 },
        'scheduling webhook retry',
      );
      setTimeout(
        () => this.attemptDelivery(registration, event, data, payload, signature, attemptNumber + 1),
        delay,
      );
    } else {
      this.moveToDLQ(registration, event, data);
    }
  }

  private moveToDLQ(registration: WebhookRegistration, event: string, data: unknown): void {
    const attempts = this.deliveryLog.filter((a) => a.registrationId === registration.id && a.event === event);
    const entry: DLQEntry = {
      id: crypto.randomUUID(),
      registration,
      payload: data,
      event,
      attempts,
      failedAt: Date.now(),
    };
    this.dlq.push(entry);
    logger.error(
      { registrationId: registration.id, url: registration.url, event, dlqId: entry.id },
      'webhook moved to dead letter queue after max retries',
    );
  }

  getDLQ(): DLQEntry[] {
    return [...this.dlq];
  }

  getDLQEntry(id: string): DLQEntry | undefined {
    return this.dlq.find((e) => e.id === id);
  }

  deleteDLQEntry(id: string): boolean {
    const idx = this.dlq.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.dlq.splice(idx, 1);
    return true;
  }

  getDeliveryLog(): DeliveryAttempt[] {
    return [...this.deliveryLog];
  }

  getStats(): { registered: number; dlqSize: number; totalAttempts: number } {
    return {
      registered: this.registrations.size,
      dlqSize: this.dlq.length,
      totalAttempts: this.deliveryLog.length,
    };
  }
}

export const webhookDeliveryService = new WebhookDeliveryService();
