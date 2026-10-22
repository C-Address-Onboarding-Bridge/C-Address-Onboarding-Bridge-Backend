import crypto from 'crypto';
import dns from 'dns';
import net from 'net';
import { logger } from '../logger';
import { hashPayload, integrityAuditLog } from './auditLog';
import { enqueueAudit } from './asyncPipeline';
import { enqueueWebhookRetry, WEBHOOK_RETRY_DELAYS_MS } from '../jobs/queue';

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
 * Recommended freshness window (in milliseconds) for receivers verifying the
 * `X-Webhook-Timestamp` header. Deliveries whose timestamp falls outside this
 * window should be rejected to prevent replay attacks.
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Returns true when the given IP literal falls in a private, loopback,
 * link-local, or cloud-metadata range that must never be reachable via a
 * user-supplied webhook URL (SSRF protection).
 */
export function isBlockedIp(ip: string): boolean {
  let addr = ip.trim();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);

  // Unwrap IPv4-mapped / IPv4-compatible IPv6 forms (e.g. ::ffff:169.254.169.254).
  const mapped = addr.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) addr = mapped[1];

  const version = net.isIP(addr);
  if (version === 4) {
    const parts = addr.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  if (version === 6) {
    const lower = addr.toLowerCase();
    if (lower === '::' || lower === '::1') return true; // unspecified / loopback
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true; // fe80::/10 link-local
    }
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
    if (lower.startsWith('ff')) return true; // ff00::/8 multicast
    return false;
  }

  // Not a valid IP literal — treat as unsafe.
  return true;
}

/**
 * Resolves the hostname of a webhook URL and rejects it when any resolved
 * address is in a blocked range. Used both at registration and delivery time.
 */
export async function assertSafeWebhookUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid webhook URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use https');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new Error('Webhook URL resolves to a blocked address');
    }
    return;
  }

  let addresses: string[];
  try {
    const records = await dns.promises.lookup(hostname, { all: true });
    addresses = records.map((r) => r.address);
  } catch {
    throw new Error('Webhook URL host could not be resolved');
  }

  if (addresses.length === 0 || addresses.some((a) => isBlockedIp(a))) {
    throw new Error('Webhook URL resolves to a blocked address');
  }
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
  private attempts: DeliveryAttempt[] = [];
  private dlq: DLQEntry[] = [];

  saveRegistration(registration: WebhookRegistration): void {
    this.registrations.set(registration.id, registration);
  }

  getRegistration(id: string): WebhookRegistration | undefined {
    return this.registrations.get(id);
  }

  getRegistrationsByApiKeyId(apiKeyId: string): WebhookRegistration[] {
    return [...this.registrations.values()].filter((r) => r.apiKeyId === apiKeyId);
  }

  deleteRegistration(id: string): boolean {
    return this.registrations.delete(id);
  }

  recordAttempt(attempt: DeliveryAttempt): void {
    this.attempts.push(attempt);
  }

  getAttempts(registrationId?: string): DeliveryAttempt[] {
    return registrationId
      ? this.attempts.filter((a) => a.registrationId === registrationId)
      : [...this.attempts];
  }

  addToDLQ(entry: DLQEntry): void {
    this.dlq.push(entry);
  }

  getDLQ(): DLQEntry[] {
    return [...this.dlq];
  }
}

/**
 * Persistent store backed by a repository. Delegates to the injected
 * repository so the service stays storage-agnostic.
 */
export class WebhookDeliveryRepository implements WebhookDeliveryStore {
  constructor(private readonly store: WebhookDeliveryStore = new InMemoryWebhookDeliveryStore()) {}

  saveRegistration(registration: WebhookRegistration): void {
    this.store.saveRegistration(registration);
  }

  getRegistration(id: string): WebhookRegistration | undefined {
    return this.store.getRegistration(id);
  }

  getRegistrationsByApiKeyId(apiKeyId: string): WebhookRegistration[] {
    return this.store.getRegistrationsByApiKeyId(apiKeyId);
  }

  deleteRegistration(id: string): boolean {
    return this.store.deleteRegistration(id);
  }

  recordAttempt(attempt: DeliveryAttempt): void {
    this.store.recordAttempt(attempt);
  }

  getAttempts(registrationId?: string): DeliveryAttempt[] {
    return this.store.getAttempts(registrationId);
  }

  addToDLQ(entry: DLQEntry): void {
    this.store.addToDLQ(entry);
  }

  getDLQ(): DLQEntry[] {
    return this.store.getDLQ();
  }
}

export class WebhookDeliveryService {
  private store: WebhookDeliveryStore;

  constructor(store: WebhookDeliveryStore = new InMemoryWebhookDeliveryStore()) {
    this.store = store;
  }

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

export class WebhookDeliveryService {
  private store: WebhookStore;
  private deliveryLogLimit: number;

  constructor(store: WebhookStore = new InMemoryWebhookStore(), deliveryLogLimit = DEFAULT_DELIVERY_LOG_LIMIT) {
    this.store = store;
    this.deliveryLogLimit = deliveryLogLimit;
  }

  register(params: { url: string; secret: string; apiKeyId: string; events: string[] }): WebhookRegistration {
    const registration: WebhookRegistration = {
      id: crypto.randomUUID(),
      url: params.url,
      secret: params.secret,
      apiKeyId: params.apiKeyId,
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

  /**
   * Signs a webhook delivery. The signed message is `${timestamp}.${payload}`
   * so the timestamp is bound to the body and cannot be tampered with or
   * replayed independently of the payload.
   */
  sign(payload: string, secret: string, timestamp: number): string {
    return crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  }

  async deliver(registration: WebhookRegistration, event: string, data: unknown): Promise<void> {
    const timestamp = Date.now();
    const payload = JSON.stringify({ event, data, timestamp });
    const signature = this.sign(payload, registration.secret, timestamp);

    await this.attemptDelivery(registration, event, data, payload, signature, timestamp, 0);
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
  emit(apiKey: string, event: string, data: unknown): void {
    void this.deliverToAll(apiKey, event, data).catch((err) => {
      logger.error(
        { apiKey, event, err: err instanceof Error ? err.message : 'unknown error' },
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
    timestamp: number,
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
      // Re-validate the target at delivery time to defeat DNS rebinding and
      // registrations created before validation was enforced.
      await assertSafeWebhookUrl(registration.url);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

      try {
        const response = await fetch(registration.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': signature,
            'X-Webhook-Timestamp': String(timestamp),
            'X-Webhook-Event': event,
          },
          body: payload,
          signal: controller.signal,
        });

        attempt.statusCode = response.status;
        this.recordAttempt(attempt);

        if (!response.ok) {
          throw new Error(`Webhook responded with status ${response.status}`);
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      attempt.error = err instanceof Error ? err.message : 'unknown error';
      this.recordAttempt(attempt);

      const deliveryAuditPayload = {
        payloadHash: hashPayload(payload),
        destination: registration.url,
        registrationId: registration.id,
        event,
        attemptNumber,
        error: attempt.error,
      };

      integrityAuditLog(deliveryAuditPayload);
      enqueueAudit({ type: 'webhook.delivery.failed', ...deliveryAuditPayload });

      if (attemptNumber < RETRY_DELAYS_MS.length) {
        enqueueWebhookRetry({
          registrationId: registration.id,
          event,
          data,
          attemptNumber: attemptNumber + 1,
          delayMs: RETRY_DELAYS_MS[attemptNumber],
        });
        return;
      }

      this.store.addToDLQ({
        id: crypto.randomUUID(),
        registration,
        payload: data,
        event,
        attempts: this.getAttempts(registration.id),
        failedAt: Date.now(),
      });

      logger.error(
        { registrationId: registration.id, event, error: attempt.error },
        'webhook delivery moved to DLQ',
      );
    }

    this.recordAttempt(attempt);

    if (attemptNumber < WEBHOOK_RETRY_DELAYS_MS.length) {
      const delay = WEBHOOK_RETRY_DELAYS_MS[attemptNumber];
      logger.info(
        { registrationId: registration.id, event, nextAttemptIn: delay, attempt: attemptNumber + 1 },
        'scheduling webhook retry',
      );
      try {
        await enqueueWebhookRetry(
          {
            registrationId: registration.id,
            url: registration.url,
            event,
            timestamp,
            payload,
            signature,
            data,
            attemptNumber: attemptNumber + 1,
          },
          delay,
        );
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
