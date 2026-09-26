import crypto from 'crypto';
import dns from 'dns';
import net from 'net';
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

const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const DELIVERY_TIMEOUT_MS = 10_000;

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
      // Re-validate the target at delivery time to defeat DNS rebinding and
      // registrations created before validation was enforced.
      await assertSafeWebhookUrl(registration.url);

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
        redirect: 'error',
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
        { registrationId: registration.id, url: registration.url, event, err: attempt.error, attempt: attemptNumber + 1 },
        'webhook delivery threw',
      );
    }

    this.deliveryLog.push(attempt);

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

    this.dlq.push({
      id: crypto.randomUUID(),
      registration,
      payload: data,
      event,
      attempts: this.deliveryLog.filter((a) => a.registrationId === registration.id),
      failedAt: Date.now(),
    });
    logger.error(
      { registrationId: registration.id, url: registration.url, event },
      'webhook delivery exhausted retries, moved to DLQ',
    );
  }

  getDeliveryLog(): DeliveryAttempt[] {
    return [...this.deliveryLog];
  }

  getDLQ(): DLQEntry[] {
    return [...this.dlq];
  }
}

export const webhookDeliveryService = new WebhookDeliveryService();
