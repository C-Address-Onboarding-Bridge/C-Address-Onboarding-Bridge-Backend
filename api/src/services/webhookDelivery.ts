import crypto from 'crypto';
import * as net from 'net';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
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

export const WEBHOOK_EVENTS = {
  FUNDING_SUBMITTED: 'funding.submitted',
  FUNDING_CONFIRMED: 'funding.confirmed',
  STATUS_CHANGED: 'status.changed',
  PROVIDER_WEBHOOK: 'provider.webhook',
} as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[keyof typeof WEBHOOK_EVENTS];

const DELIVERY_TIMEOUT_MS = 10_000;
const DEFAULT_DELIVERY_LOG_LIMIT = 10_000;

function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === 'unicast';
  } catch {
    return false;
  }
}

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

export function isBlockedIp(ip: string): boolean {
  let address = ip.trim();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);

  const version = net.isIP(address);
  if (version === 4) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return true;
    const [first, second] = parts;
    return first === 0
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 100 && second >= 64 && second <= 127)
      || first >= 224;
  }

  if (version === 6) {
    const value = ipv6ToBigInt(address);
    const prefix96 = value >> 32n;
    const embeddedIpv4 = value & 0xffffffffn;
    if (prefix96 === 0n || prefix96 === 0xffffn || prefix96 === 0x64ff9b0000000000000000n) {
      return isBlockedIp(ipv4FromBigInt(embeddedIpv4));
    }
    if (value >> 112n === 0x2002n) {
      return isBlockedIp(ipv4FromBigInt((value >> 80n) & 0xffffffffn));
    }

    const lower = address.toLowerCase();
    return lower === '::'
      || lower === '::1'
      || lower.startsWith('fe8')
      || lower.startsWith('fe9')
      || lower.startsWith('fea')
      || lower.startsWith('feb')
      || lower.startsWith('fc')
      || lower.startsWith('fd')
      || lower.startsWith('ff');
  }

  return true;
}

async function resolveSafeWebhookAddress(url: string): Promise<{
  hostname: string;
  address: string;
  family: number;
}> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Invalid webhook URL');
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
    throw new Error('Webhook URL must use HTTPS without credentials');
  }

  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });

  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedIp(address) || !isPublicAddress(address))) {
    throw new Error('Webhook URL resolves to a blocked address');
  }

  return { hostname, ...addresses[0] };
}

export async function assertSafeWebhookUrl(rawUrl: string): Promise<void> {
  await resolveSafeWebhookAddress(rawUrl);
}

export interface WebhookStore {
  saveRegistration(_registration: WebhookRegistration): Promise<void>;
  deleteRegistration(_id: string): Promise<boolean>;
  getRegistration(_id: string): Promise<WebhookRegistration | undefined>;
  listRegistrations(): Promise<WebhookRegistration[]>;
  getRegistrationsByApiKeyId(_apiKeyId: string): Promise<WebhookRegistration[]>;
  appendDeliveryAttempt(_attempt: DeliveryAttempt): Promise<void>;
  listDeliveryAttempts(): Promise<DeliveryAttempt[]>;
  pruneDeliveryLog(_maxEntries: number): Promise<void>;
  saveDLQEntry(_entry: DLQEntry): Promise<void>;
  listDLQEntries(): Promise<DLQEntry[]>;
  getDLQEntry(_id: string): Promise<DLQEntry | undefined>;
  deleteDLQEntry(_id: string): Promise<boolean>;
}

export class InMemoryWebhookStore implements WebhookStore {
  private registrations = new Map<string, WebhookRegistration>();
  private attempts: DeliveryAttempt[] = [];
  private dlq = new Map<string, DLQEntry>();

  async saveRegistration(registration: WebhookRegistration): Promise<void> {
    this.registrations.set(registration.id, { ...registration, events: [...registration.events] });
  }

  async deleteRegistration(id: string): Promise<boolean> {
    const deleted = this.registrations.delete(id);
    if (deleted) {
      this.attempts = this.attempts.filter((attempt) => attempt.registrationId !== id);
      for (const [entryId, entry] of this.dlq) {
        if (entry.registration.id === id) this.dlq.delete(entryId);
      }
    }
    return deleted;
  }

  async getRegistration(id: string): Promise<WebhookRegistration | undefined> {
    const registration = this.registrations.get(id);
    return registration ? { ...registration, events: [...registration.events] } : undefined;
  }

  async listRegistrations(): Promise<WebhookRegistration[]> {
    return [...this.registrations.values()].map((registration) => ({
      ...registration,
      events: [...registration.events],
    }));
  }

  async getRegistrationsByApiKeyId(apiKeyId: string): Promise<WebhookRegistration[]> {
    return (await this.listRegistrations()).filter((registration) => registration.apiKeyId === apiKeyId);
  }

  async appendDeliveryAttempt(attempt: DeliveryAttempt): Promise<void> {
    this.attempts.push({ ...attempt });
  }

  async listDeliveryAttempts(): Promise<DeliveryAttempt[]> {
    return this.attempts.map((attempt) => ({ ...attempt }));
  }

  async pruneDeliveryLog(maxEntries: number): Promise<void> {
    if (this.attempts.length > maxEntries) {
      this.attempts.splice(0, this.attempts.length - maxEntries);
    }
  }

  async saveDLQEntry(entry: DLQEntry): Promise<void> {
    this.dlq.set(entry.id, {
      ...entry,
      registration: { ...entry.registration, events: [...entry.registration.events] },
      attempts: entry.attempts.map((attempt) => ({ ...attempt })),
    });
  }

  async listDLQEntries(): Promise<DLQEntry[]> {
    return [...this.dlq.values()].map((entry) => ({
      ...entry,
      registration: { ...entry.registration, events: [...entry.registration.events] },
      attempts: entry.attempts.map((attempt) => ({ ...attempt })),
    }));
  }

  async getDLQEntry(id: string): Promise<DLQEntry | undefined> {
    return (await this.listDLQEntries()).find((entry) => entry.id === id);
  }

  async deleteDLQEntry(id: string): Promise<boolean> {
    return this.dlq.delete(id);
  }
}

export class WebhookDeliveryService {
  private readonly store: WebhookStore;
  private readonly deliveryLogLimit: number;

  constructor(
    store: WebhookStore = new InMemoryWebhookStore(),
    deliveryLogLimit = DEFAULT_DELIVERY_LOG_LIMIT,
  ) {
    this.store = store;
    this.deliveryLogLimit = deliveryLogLimit;
  }

  async register(params: { url: string; secret: string; apiKeyId: string; events: string[] }): Promise<WebhookRegistration> {
    const registration: WebhookRegistration = {
      id: crypto.randomUUID(),
      url: params.url,
      secret: params.secret,
      apiKeyId: params.apiKeyId,
      events: [...params.events],
      createdAt: Date.now(),
    };
    await this.store.saveRegistration(registration);
    logger.info({ registrationId: registration.id, url: params.url }, 'webhook registered');
    return registration;
  }

  async unregister(id: string): Promise<boolean> {
    return this.store.deleteRegistration(id);
  }

  async getRegistration(id: string): Promise<WebhookRegistration | undefined> {
    return this.store.getRegistration(id);
  }

  async getRegistrationsByApiKeyId(apiKeyId: string): Promise<WebhookRegistration[]> {
    return this.store.getRegistrationsByApiKeyId(apiKeyId);
  }

  sign(payload: string, secret: string, timestamp = Date.now()): string {
    return crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  }

  async deliver(registration: WebhookRegistration, event: string, data: unknown): Promise<void> {
    const timestamp = Date.now();
    const payload = JSON.stringify({ event, data, timestamp });
    const signature = this.sign(payload, registration.secret, timestamp);
    await this.attemptDelivery(registration, event, data, payload, signature, timestamp, 0);
  }

  async deliverToAll(apiKeyId: string, event: string, data: unknown): Promise<void> {
    const registrations = await this.getRegistrationsByApiKeyId(apiKeyId);
    const targets = registrations.filter((registration) =>
      registration.events.includes(event) || registration.events.includes('*'),
    );
    await Promise.all(targets.map((registration) => this.deliver(registration, event, data)));
  }

  emit(apiKeyId: string, event: string, data: unknown): void {
    void this.deliverToAll(apiKeyId, event, data).catch((err) => {
      logger.error(
        { apiKeyId, event, err: err instanceof Error ? err.message : 'unknown error' },
        'webhook emit failed',
      );
    });
  }

  private async recordAttempt(attempt: DeliveryAttempt): Promise<void> {
    await this.store.appendDeliveryAttempt(attempt);
    await this.store.pruneDeliveryLog(this.deliveryLogLimit);
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

    let dispatcher: Agent | undefined;
    try {
      const vettedAddress = await resolveSafeWebhookAddress(registration.url);
      const pinnedLookup = (
        requestedHostname: string,
        options: { all?: boolean } | number,
        callback: (
          _error: NodeJS.ErrnoException | null,
          _address: string | { address: string; family: number }[],
          _family?: number,
        ) => void,
      ) => {
        if (requestedHostname !== vettedAddress.hostname || isBlockedIp(vettedAddress.address)) {
          const error = new Error('Webhook connection did not match its vetted destination') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          callback(error, '');
          return;
        }

        if (typeof options === 'object' && options.all) {
          callback(null, [{ address: vettedAddress.address, family: vettedAddress.family }]);
        } else {
          callback(null, vettedAddress.address, vettedAddress.family);
        }
      };
      dispatcher = new Agent({ connect: { lookup: pinnedLookup } });

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
          dispatcher,
        } as RequestInit & { dispatcher: Agent });
        attempt.statusCode = response.status;
        if (!response.ok) attempt.error = `Webhook responded with status ${response.status}`;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      attempt.error = err instanceof Error ? err.message : 'unknown error';
    } finally {
      if (dispatcher) void dispatcher.destroy();
    }

    await this.recordAttempt(attempt);

    const auditPayload = {
      payloadHash: hashPayload(payload),
      destination: registration.url,
      registrationId: registration.id,
      event,
      attemptNumber: attemptNumber + 1,
      statusCode: attempt.statusCode,
      result: attempt.error ? 'failed' : 'success',
      error: attempt.error,
    };
    enqueueAudit(
      'webhook_delivery',
      auditPayload,
      registration.apiKeyId,
      () => integrityAuditLog.append('webhook_delivery', auditPayload, registration.apiKeyId),
    );

    if (!attempt.error) {
      logger.info(
        { registrationId: registration.id, url: registration.url, event, attempt: attemptNumber + 1 },
        'webhook delivered',
      );
      return;
    }

    logger.warn(
      { registrationId: registration.id, url: registration.url, event, error: attempt.error, attempt: attemptNumber + 1 },
      'webhook delivery failed',
    );

    if (attemptNumber < WEBHOOK_RETRY_DELAYS_MS.length) {
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
          WEBHOOK_RETRY_DELAYS_MS[attemptNumber],
        );
        return;
      } catch (err) {
        logger.error(
          { registrationId: registration.id, event, error: err instanceof Error ? err.message : String(err) },
          'failed to enqueue webhook retry',
        );
      }
    }

    await this.moveToDLQ(registration, event, data);
  }

  private async moveToDLQ(registration: WebhookRegistration, event: string, data: unknown): Promise<void> {
    const attempts = (await this.store.listDeliveryAttempts()).filter(
      (attempt) => attempt.registrationId === registration.id && attempt.event === event,
    );
    const entry: DLQEntry = {
      id: crypto.randomUUID(),
      registration,
      payload: data,
      event,
      attempts,
      failedAt: Date.now(),
    };
    await this.store.saveDLQEntry(entry);
    logger.error(
      { registrationId: registration.id, url: registration.url, event, dlqId: entry.id },
      'webhook moved to dead letter queue after max retries',
    );
  }

  async getDLQ(): Promise<DLQEntry[]> {
    return this.store.listDLQEntries();
  }

  async getDLQEntry(id: string): Promise<DLQEntry | undefined> {
    return this.store.getDLQEntry(id);
  }

  async deleteDLQEntry(id: string): Promise<boolean> {
    return this.store.deleteDLQEntry(id);
  }

  async getDeliveryLog(): Promise<DeliveryAttempt[]> {
    return this.store.listDeliveryAttempts();
  }

  async getStats(): Promise<{ registered: number; dlqSize: number; totalAttempts: number }> {
    const [registrations, dlq, attempts] = await Promise.all([
      this.store.listRegistrations(),
      this.store.listDLQEntries(),
      this.store.listDeliveryAttempts(),
    ]);
    return { registered: registrations.length, dlqSize: dlq.length, totalAttempts: attempts.length };
  }
}

export let webhookDeliveryService = new WebhookDeliveryService();

export function setWebhookDeliveryService(service: WebhookDeliveryService): void {
  webhookDeliveryService = service;
}
