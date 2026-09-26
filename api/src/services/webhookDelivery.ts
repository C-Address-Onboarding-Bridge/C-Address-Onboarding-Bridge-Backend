import crypto from 'crypto';
import { logger } from '../index';
import { hashPayload, integrityAuditLog } from './auditLog';
import { enqueueAudit } from './asyncPipeline';
import { enqueueWebhookRetry } from '../jobs/queue';

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

/**
 * Minimal persistence contract for webhook state. Implementations may back this
 * with Postgres (production) or an in-memory store (tests / single-process).
 */
export interface WebhookStore {
  saveRegistration(registration: WebhookRegistration): void;
  deleteRegistration(id: string): boolean;
  getRegistration(id: string): WebhookRegistration | undefined;
  listRegistrations(): WebhookRegistration[];
  appendDeliveryAttempt(attempt: DeliveryAttempt): void;
  listDeliveryAttempts(): DeliveryAttempt[];
  pruneDeliveryLog(maxEntries: number): void;
  saveDLQEntry(entry: DLQEntry): void;
  listDLQEntries(): DLQEntry[];
  getDLQEntry(id: string): DLQEntry | undefined;
  deleteDLQEntry(id: string): boolean;
}

/**
 * In-memory fallback store. Used when no Postgres-backed store is injected so
 * the service keeps working in tests and single-process deployments.
 */
export class InMemoryWebhookStore implements WebhookStore {
  private registrations = new Map<string, WebhookRegistration>();
  private dlq: DLQEntry[] = [];
  private deliveryLog: DeliveryAttempt[] = [];

  saveRegistration(registration: WebhookRegistration): void {
    this.registrations.set(registration.id, registration);
  }

  deleteRegistration(id: string): boolean {
    return this.registrations.delete(id);
  }

  getRegistration(id: string): WebhookRegistration | undefined {
    return this.registrations.get(id);
  }

  listRegistrations(): WebhookRegistration[] {
    return [...this.registrations.values()];
  }

  appendDeliveryAttempt(attempt: DeliveryAttempt): void {
    this.deliveryLog.push(attempt);
  }

  listDeliveryAttempts(): DeliveryAttempt[] {
    return [...this.deliveryLog];
  }

  pruneDeliveryLog(maxEntries: number): void {
    if (this.deliveryLog.length > maxEntries) {
      this.deliveryLog.splice(0, this.deliveryLog.length - maxEntries);
    }
  }

  saveDLQEntry(entry: DLQEntry): void {
    this.dlq.push(entry);
  }

  listDLQEntries(): DLQEntry[] {
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
}

const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const DELIVERY_TIMEOUT_MS = 10_000;
const DEFAULT_DELIVERY_LOG_LIMIT = 10_000;

export class WebhookDeliveryService {
  private store: WebhookStore;
  private deliveryLogLimit: number;

  constructor(store: WebhookStore = new InMemoryWebhookStore(), deliveryLogLimit = DEFAULT_DELIVERY_LOG_LIMIT) {
    this.store = store;
    this.deliveryLogLimit = deliveryLogLimit;
  }

  register(params: { url: string; secret: string; apiKey: string; events: string[] }): WebhookRegistration {
    const registration: WebhookRegistration = {
      id: crypto.randomUUID(),
      url: params.url,
      secret: params.secret,
      apiKey: params.apiKey,
      events: params.events,
      createdAt: Date.now(),
    };
    this.store.saveRegistration(registration);
    logger.info({ registrationId: registration.id, url: params.url }, 'webhook registered');
    return registration;
  }

  unregister(id: string): boolean {
    return this.store.deleteRegistration(id);
  }

  getRegistration(id: string): WebhookRegistration | undefined {
    return this.store.getRegistration(id);
  }

  getRegistrationsByApiKey(apiKey: string): WebhookRegistration[] {
    return this.store.listRegistrations().filter((r) => r.apiKey === apiKey);
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

  private recordAttempt(attempt: DeliveryAttempt): void {
    this.store.appendDeliveryAttempt(attempt);
    this.store.pruneDeliveryLog(this.deliveryLogLimit);
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

      const deliveryAuditPayload = {
        payloadHash: hashPayload(payload),
        destination: registration.url,
        registrationId: registration.id,
        event,
        attemptNumber: attemptNumber + 1,
        statusCode: response.status,
        result: response.ok ? 'success' : 'failed',
      };
      enqueueAudit(
        'webhook_delivery',
        deliveryAuditPayload,
        registration.apiKey,
        () => integrityAuditLog.append('webhook_delivery', deliveryAuditPayload, registration.apiKey),
      );

      if (response.ok) {
        logger.info(
          { registrationId: registration.id, url: registration.url, event, attempt: attemptNumber + 1 },
          'webhook delivered',
        );
        this.recordAttempt(attempt);
        return;
      }

      attempt.error = `HTTP ${response.status}`;
      logger.warn(
        { registrationId: registration.id, url: registration.url, event, status: response.status, attempt: attemptNumber + 1 },
        'webhook delivery failed with non-2xx status',
      );
    } catch (err) {
      attempt.error = err instanceof Error ? err.message : 'unknown error';
      const errorAuditPayload = {
        payloadHash: hashPayload(payload),
        destination: registration.url,
        registrationId: registration.id,
        event,
        attemptNumber: attemptNumber + 1,
        result: 'error',
        error: attempt.error,
      };
      enqueueAudit(
        'webhook_delivery',
        errorAuditPayload,
        registration.apiKey,
        () => integrityAuditLog.append('webhook_delivery', errorAuditPayload, registration.apiKey),
      );
      logger.warn(
        { registrationId: registration.id, url: registration.url, event, error: attempt.error, attempt: attemptNumber + 1 },
        'webhook delivery error',
      );
    }

    this.recordAttempt(attempt);

    if (attemptNumber < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[attemptNumber];
      logger.info(
        { registrationId: registration.id, event, nextAttemptIn: delay, attempt: attemptNumber + 1 },
        'scheduling webhook retry',
      );
      try {
        await enqueueWebhookRetry({
          registrationId: registration.id,
          event,
          payload,
          signature,
          data,
          attemptNumber: attemptNumber + 1,
        });
      } catch (err) {
        logger.error(
          { registrationId: registration.id, event, error: err instanceof Error ? err.message : String(err) },
          'failed to enqueue webhook retry',
        );
        this.moveToDLQ(registration, event, data);
      }
    } else {
      this.moveToDLQ(registration, event, data);
    }
  }

  private moveToDLQ(registration: WebhookRegistration, event: string, data: unknown): void {
    const attempts = this.store
      .listDeliveryAttempts()
      .filter((a) => a.registrationId === registration.id && a.event === event);
    const entry: DLQEntry = {
      id: crypto.randomUUID(),
      registration,
      payload: data,
      event,
      attempts,
      failedAt: Date.now(),
    };
    this.store.saveDLQEntry(entry);
    logger.error(
      { registrationId: registration.id, url: registration.url, event, dlqId: entry.id },
      'webhook moved to dead letter queue after max retries',
    );
  }

  getDLQ(): DLQEntry[] {
    return this.store.listDLQEntries();
  }

  getDLQEntry(id: string): DLQEntry | undefined {
    return this.store.getDLQEntry(id);
  }

  deleteDLQEntry(id: string): boolean {
    return this.store.deleteDLQEntry(id);
  }

  getDeliveryLog(): DeliveryAttempt[] {
    return this.store.listDeliveryAttempts();
  }

  getStats(): { registered: number; dlqSize: number; totalAttempts: number } {
    return {
      registered: this.store.listRegistrations().length,
      dlqSize: this.store.listDLQEntries().length,
      totalAttempts: this.store.listDeliveryAttempts().length,
    };
  }
}

export const webhookDeliveryService = new WebhookDeliveryService();
