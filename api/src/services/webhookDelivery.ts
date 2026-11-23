import crypto from 'crypto';
import { logger } from '../index';
import { hashPayload, integrityAuditLog } from './auditLog';
import { enqueueAudit } from './asyncPipeline';
import { enqueueWebhookRetry, WEBHOOK_RETRY_DELAYS_MS } from '../jobs/queue';
import { safeWebhookFetch } from './webhookSecurity';
import {
  buildWebhookHeaders,
  computeWebhookSignature,
  toUnixSeconds,
} from './webhookSignature';

// Re-exported from the shared SSRF module so existing imports from
// `../services/webhookDelivery` (webhookAdmin.ts, webhookIp.test.ts) keep
// working without a call-site change.
export { isBlockedIp, assertSafeWebhookUrl } from './webhookSecurity';

export interface WebhookRegistration {
  id: string;
  url: string;
  secret: string;
  apiKeyId: string;
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
  /** Stable dedupe key across every attempt of this delivery (issue #1061). */
  webhookId: string;
  payload: unknown;
  event: string;
  attempts: DeliveryAttempt[];
  failedAt: number;
}

/**
 * Canonical webhook event names emitted by the API. Kept in one place so the
 * delivery wiring, the OpenAPI documentation, and integrators all agree on the
 * exact strings.
 */
export const WEBHOOK_EVENTS = {
  FUNDING_SUBMITTED: 'funding.submitted',
  FUNDING_CONFIRMED: 'funding.confirmed',
  STATUS_CHANGED: 'status.changed',
  PROVIDER_WEBHOOK: 'provider.webhook',
} as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[keyof typeof WEBHOOK_EVENTS];

const DELIVERY_TIMEOUT_MS = 10_000;
const DEFAULT_DELIVERY_LOG_LIMIT = 10_000;

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
  private attempts: DeliveryAttempt[] = [];
  private dlq: DLQEntry[] = [];

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
    this.attempts.push(attempt);
  }

  listDeliveryAttempts(): DeliveryAttempt[] {
    return [...this.attempts];
  }

  pruneDeliveryLog(maxEntries: number): void {
    if (this.attempts.length > maxEntries) {
      this.attempts.splice(0, this.attempts.length - maxEntries);
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

/**
 * Webhook delivery service.
 *
 * SSRF hardening:
 * - safeWebhookFetch() resolves the target hostname once and pins the result
 *   into an undici Agent lookup, closing the DNS-rebinding TOCTOU window;
 * - fetch() runs with `redirect: 'error'` so a 3xx cannot re-send the signed
 *   POST body to an internal address.
 *
 * Header contract (issue #1060): every attempt - first delivery or retry -
 * builds its headers via buildWebhookHeaders() so receivers can use one
 * verification rule.
 *
 * Retry contract (issue #1061): one `webhookId` per deliver() call flows
 * through the retry job so receivers can dedupe. The retry job does NOT carry
 * a signature or timestamp - the worker re-signs with a fresh `now` so the
 * final retry (~370 s later) still passes a 300 s replay window.
 */
export class WebhookDeliveryService {
  private store: WebhookStore;
  private deliveryLogLimit: number;

  constructor(store: WebhookStore = new InMemoryWebhookStore(), deliveryLogLimit = DEFAULT_DELIVERY_LOG_LIMIT) {
    this.store = store;
    this.deliveryLogLimit = deliveryLogLimit;
  }

  register(params: {
    url: string;
    secret: string;
    apiKeyId?: string;
    apiKey?: string;
    events: string[];
  }): WebhookRegistration {
    const registration: WebhookRegistration = {
      id: crypto.randomUUID(),
      url: params.url,
      secret: params.secret,
      // `apiKeyId` is the canonical field; `apiKey` is accepted as a legacy
      // alias so older call sites keep working.
      apiKeyId: params.apiKeyId ?? params.apiKey ?? '',
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

  getRegistrationsByApiKeyId(apiKeyId: string): WebhookRegistration[] {
    return this.store.listRegistrations().filter((r) => r.apiKeyId === apiKeyId);
  }

  /** Legacy alias kept for callers that use the shorter name. */
  getRegistrationsByApiKey(apiKey: string): WebhookRegistration[] {
    return this.getRegistrationsByApiKeyId(apiKey);
  }

  /**
   * Signs a webhook delivery.
   *
   * - 2-arg form: bare HMAC of `payload`. Legacy, kept for callers / tests
   *   that predate the canonical `${timestamp}.${payload}` contract.
   * - 3-arg form: canonical HMAC of `${timestampSeconds}.${payload}`, identical
   *   to computeWebhookSignature(secret, timestampSeconds, payload).
   */
  sign(payload: string, secret: string, timestampSeconds?: number): string {
    if (timestampSeconds !== undefined) {
      return computeWebhookSignature(secret, timestampSeconds, payload);
    }
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  async deliver(registration: WebhookRegistration, event: string, data: unknown): Promise<void> {
    // One UUID per logical delivery - all retries share it so receivers can
    // dedupe across attempts (issue #1061).
    const webhookId = crypto.randomUUID();
    // Unix seconds - matches the header unit and the signed-message contract.
    const timestampSeconds = toUnixSeconds(Date.now());
    const payload = JSON.stringify({ event, data, timestamp: timestampSeconds });
    const signature = computeWebhookSignature(registration.secret, timestampSeconds, payload);
    await this.attemptDelivery(
      registration,
      event,
      data,
      payload,
      signature,
      timestampSeconds,
      webhookId,
      0,
    );
  }

  async deliverToAll(apiKeyId: string, event: string, data: unknown): Promise<void> {
    const targets = this.getRegistrationsByApiKeyId(apiKeyId).filter(
      (r) => r.events.includes(event) || r.events.includes('*'),
    );
    await Promise.all(targets.map((r) => this.deliver(r, event, data)));
  }

  /**
   * Fire-and-forget helper used by route handlers to emit a state-change event
   * to every webhook registered for the given API key. Delivery failures are
   * logged and never propagate to the caller so request handling is unaffected.
   */
  emit(apiKeyId: string, event: string, data: unknown): void {
    void this.deliverToAll(apiKeyId, event, data).catch((err) => {
      logger.error(
        { apiKeyId, event, err: err instanceof Error ? err.message : 'unknown error' },
        'webhook emit failed',
      );
    });
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
    timestampSeconds: number,
    webhookId: string,
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
      try {
        // SSRF-safe: resolve once, pin the answer, and refuse redirects.
        const response = await safeWebhookFetch(registration.url, {
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

        attempt.statusCode = response.status;
        if (!response.ok) {
          attempt.error = `HTTP ${response.status}`;
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      attempt.error = err instanceof Error ? err.message : 'unknown error';
    }

    this.recordAttempt(attempt);

    if (!attempt.error) {
      logger.info(
        {
          registrationId: registration.id,
          url: registration.url,
          event,
          webhookId,
          status: attempt.statusCode,
          attempt: attemptNumber + 1,
        },
        'webhook delivered',
      );
      return;
    }

    logger.warn(
      {
        registrationId: registration.id,
        url: registration.url,
        event,
        webhookId,
        status: attempt.statusCode,
        error: attempt.error,
        attempt: attemptNumber + 1,
      },
      'webhook delivery failed',
    );

    const deliveryAuditPayload = {
      payloadHash: hashPayload(payload),
      destination: registration.url,
      registrationId: registration.id,
      event,
      webhookId,
      attemptNumber: attemptNumber + 1,
      error: attempt.error,
    };
    try {
      enqueueAudit(
        'webhook_delivery',
        deliveryAuditPayload,
        registration.apiKeyId,
        () => integrityAuditLog.append('webhook_delivery', deliveryAuditPayload, registration.apiKeyId),
      );
    } catch (auditErr) {
      logger.warn(
        { err: auditErr instanceof Error ? auditErr.message : String(auditErr) },
        'failed to enqueue webhook delivery audit',
      );
    }

    if (attemptNumber < WEBHOOK_RETRY_DELAYS_MS.length) {
      const delay = WEBHOOK_RETRY_DELAYS_MS[attemptNumber];
      try {
        // Issue #1061: the retry job carries the raw payload + webhookId, NOT
        // the signature or timestamp. The worker re-signs with a fresh `now`
        // so the last retry (10 + 60 + 300 = 370 s after signing) still lands
        // inside the documented 300 s replay window.
        await enqueueWebhookRetry(
          {
            registrationId: registration.id,
            url: registration.url,
            event,
            webhookId,
            payload,
            data,
            attemptNumber: attemptNumber + 1,
          },
          delay,
        );
        logger.info(
          {
            registrationId: registration.id,
            event,
            webhookId,
            nextAttemptIn: delay,
            attempt: attemptNumber + 1,
          },
          'scheduling webhook retry',
        );
        return;
      } catch (err) {
        logger.error(
          {
            registrationId: registration.id,
            event,
            error: err instanceof Error ? err.message : String(err),
          },
          'failed to enqueue webhook retry',
        );
      }
    }

    this.moveToDLQ(registration, event, data, webhookId);
  }

  private moveToDLQ(
    registration: WebhookRegistration,
    event: string,
    data: unknown,
    webhookId: string,
  ): void {
    const attempts = this.store
      .listDeliveryAttempts()
      .filter((a) => a.registrationId === registration.id && a.event === event);
    const entry: DLQEntry = {
      id: crypto.randomUUID(),
      registration,
      webhookId,
      payload: data,
      event,
      attempts,
      failedAt: Date.now(),
    };
    this.store.saveDLQEntry(entry);
    logger.error(
      { registrationId: registration.id, url: registration.url, event, webhookId, dlqId: entry.id },
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
