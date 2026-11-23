import crypto from 'crypto';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { Agent } from 'undici';
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
  /** Stable across every attempt of one delivery; sent as `X-Webhook-Id`. */
  deliveryId: string;
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

function ipv6ToBigInt(address: string): bigint {
  let normalized = address.toLowerCase();
  const ipv4Tail = normalized.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Tail) {
    const octets = ipv4Tail[1].split('.').map(Number);
    const first = ((octets[0] << 8) | octets[1]).toString(16);
    const second = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, ipv4Tail.index)}${first}:${second}`;
  }

  const [leftPart, rightPart = ''] = normalized.split('::');
  const left = leftPart ? leftPart.split(':') : [];
  const right = rightPart ? rightPart.split(':') : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group || '0'}`), 0n);
}

function ipv4FromBigInt(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.');
}

/**
 * Returns true when the given IP literal falls in a private, loopback,
 * link-local, or cloud-metadata range that must never be reachable via a
 * user-supplied webhook URL (SSRF protection).
 */
export function isBlockedIp(ip: string): boolean {
  let addr = ip.trim();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);

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
    const value = ipv6ToBigInt(addr);
    const prefix96 = value >> 32n;
    const embeddedIpv4 = value & 0xffffffffn;
    if (prefix96 === 0n || prefix96 === 0xffffn || prefix96 === 0x64ff9b0000000000000000n) {
      return isBlockedIp(ipv4FromBigInt(embeddedIpv4));
    }
    if (value >> 112n === 0x2002n) {
      return isBlockedIp(ipv4FromBigInt((value >> 80n) & 0xffffffffn));
    }

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

/** The one address a delivery is allowed to connect to, vetted up front. */
interface VettedAddress {
  hostname: string;
  address: string;
  family: number;
}

/**
 * Resolve a webhook URL's host once and reject it when any answer is in a
 * blocked range. The returned address is the one the delivery is then pinned
 * to (see `pinnedDispatcher`), so a second DNS answer cannot rebind the
 * connection to an internal address after the check.
 */
async function resolveSafeWebhookAddress(rawUrl: string): Promise<VettedAddress> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid webhook URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Webhook URL must not carry credentials');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const literal = net.isIP(hostname);
  if (literal) {
    if (isBlockedIp(hostname)) {
      throw new Error('Webhook URL resolves to a blocked address');
    }
    return { hostname, address: hostname, family: literal };
  }

  let records: { address: string; family: number }[];
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Webhook URL host could not be resolved');
  }

  if (records.length === 0 || records.some((r) => isBlockedIp(r.address))) {
    throw new Error('Webhook URL resolves to a blocked address');
  }
  return { hostname, address: records[0].address, family: records[0].family };
}

/**
 * Resolves the hostname of a webhook URL and rejects it when any resolved
 * address is in a blocked range. Used both at registration and delivery time.
 */
export async function assertSafeWebhookUrl(rawUrl: string): Promise<void> {
  await resolveSafeWebhookAddress(rawUrl);
}

/** An undici dispatcher whose DNS lookup can only ever return the vetted address. */
function pinnedDispatcher(vetted: VettedAddress): Agent {
  const pinnedLookup = (
    requestedHostname: string,
    options: { all?: boolean } | number,
    callback: (
      _error: NodeJS.ErrnoException | null,
      _address: string | { address: string; family: number }[],
      _family?: number,
    ) => void,
  ) => {
    if (requestedHostname !== vetted.hostname || isBlockedIp(vetted.address)) {
      const error = new Error('Webhook connection did not match its vetted destination') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      callback(error, '');
      return;
    }
    if (typeof options === 'object' && options.all) {
      callback(null, [{ address: vetted.address, family: vetted.family }]);
    } else {
      callback(null, vetted.address, vetted.family);
    }
  };
  return new Agent({ connect: { lookup: pinnedLookup } });
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

export class WebhookDeliveryService {
  private store: WebhookStore;
  private deliveryLogLimit: number;

  constructor(store: WebhookStore = new InMemoryWebhookStore(), deliveryLogLimit = DEFAULT_DELIVERY_LOG_LIMIT) {
    this.store = store;
    this.deliveryLogLimit = deliveryLogLimit;
  }

  register(params: { id?: string; url: string; secret: string; apiKeyId: string; events: string[] }): WebhookRegistration {
    const registration: WebhookRegistration = {
      id: params.id ?? crypto.randomUUID(),
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
    // One id per delivery, reused by every retry, so a receiver can dedupe.
    const deliveryId = crypto.randomUUID();

    await this.attemptDelivery({ registration, event, data, payload, signature, timestamp, deliveryId }, 0);
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

  /**
   * One delivery attempt. Every call ends in exactly one of three ways: a 2xx
   * returns; a failure with retries left enqueues the next attempt; a failure
   * with none left (or whose retry cannot be enqueued) goes to the DLQ. The
   * attempt is recorded, and audited, exactly once either way.
   */
  private async attemptDelivery(
    delivery: {
      registration: WebhookRegistration;
      event: string;
      data: unknown;
      payload: string;
      signature: string;
      timestamp: number;
      deliveryId: string;
    },
    attemptNumber: number,
  ): Promise<void> {
    const { registration, event, data, payload, signature, timestamp, deliveryId } = delivery;
    const attempt: DeliveryAttempt = {
      id: crypto.randomUUID(),
      deliveryId,
      registrationId: registration.id,
      webhookUrl: registration.url,
      event,
      timestamp: Date.now(),
      attemptNumber,
    };

    let timeout: NodeJS.Timeout | undefined;
    let dispatcher: Agent | undefined;
    try {
      // Re-validate the target at delivery time, and pin the connection to the
      // address that passed, to defeat DNS rebinding and registrations created
      // before validation was enforced.
      const vetted = await resolveSafeWebhookAddress(registration.url);
      dispatcher = pinnedDispatcher(vetted);

      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

      const response = await fetch(registration.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Id': deliveryId,
          'X-Webhook-Signature': `sha256=${signature}`,
          'X-Webhook-Timestamp': String(timestamp),
          'X-Webhook-Event': event,
          'X-Webhook-Attempt': String(attemptNumber + 1),
        },
        body: payload,
        signal: controller.signal,
        redirect: 'error',
        dispatcher,
      } as RequestInit & { dispatcher: Agent });

      attempt.statusCode = response.status;
      if (!response.ok) attempt.error = `Webhook responded with status ${response.status}`;
    } catch (err) {
      attempt.error = err instanceof Error ? err.message : 'unknown error';
    } finally {
      if (timeout) clearTimeout(timeout);
      if (dispatcher) void dispatcher.destroy();
    }

    this.recordAttempt(attempt);
    this.audit(registration, event, payload, attempt);

    if (attempt.error === undefined) {
      logger.info(
        { registrationId: registration.id, event, deliveryId, attempt: attemptNumber + 1 },
        'webhook delivered',
      );
      return;
    }

    logger.warn(
      { registrationId: registration.id, event, deliveryId, error: attempt.error, attempt: attemptNumber + 1 },
      'webhook delivery failed',
    );

    if (attemptNumber < WEBHOOK_RETRY_DELAYS_MS.length) {
      const delay = WEBHOOK_RETRY_DELAYS_MS[attemptNumber];
      try {
        await enqueueWebhookRetry(
          {
            registrationId: registration.id,
            deliveryId,
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
        logger.info(
          { registrationId: registration.id, event, deliveryId, nextAttemptIn: delay, attempt: attemptNumber + 2 },
          'scheduled webhook retry',
        );
        return;
      } catch (err) {
        // Without a queue there is no retry; the DLQ is the only place left
        // that keeps the delivery from being lost.
        logger.error(
          { registrationId: registration.id, event, deliveryId, error: err instanceof Error ? err.message : String(err) },
          'failed to enqueue webhook retry',
        );
      }
    }

    this.moveToDLQ(registration, event, data, deliveryId);
  }

  private audit(registration: WebhookRegistration, event: string, payload: string, attempt: DeliveryAttempt): void {
    const auditPayload: Record<string, unknown> = {
      payloadHash: hashPayload(payload),
      destination: registration.url,
      registrationId: registration.id,
      deliveryId: attempt.deliveryId,
      event,
      attemptNumber: attempt.attemptNumber + 1,
      result: attempt.error === undefined ? 'success' : 'failed',
      ...(attempt.statusCode !== undefined ? { statusCode: attempt.statusCode } : {}),
      ...(attempt.error !== undefined ? { error: attempt.error } : {}),
    };
    // The actor is the API key *id*, never the raw key.
    enqueueAudit('webhook_delivery', auditPayload, registration.apiKeyId, () =>
      integrityAuditLog.append('webhook_delivery', auditPayload, registration.apiKeyId),
    );
  }

  private moveToDLQ(registration: WebhookRegistration, event: string, data: unknown, deliveryId: string): void {
    const attempts = this.store.listDeliveryAttempts().filter((a) => a.deliveryId === deliveryId);
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
      { registrationId: registration.id, url: registration.url, event, deliveryId, dlqId: entry.id },
      'webhook moved to dead letter queue',
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
