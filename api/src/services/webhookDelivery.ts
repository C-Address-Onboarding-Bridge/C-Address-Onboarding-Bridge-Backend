import crypto from 'crypto';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';
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

const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const DELIVERY_TIMEOUT_MS = 10_000;

function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === 'unicast';
  } catch {
    return false;
  }
}

async function resolveSafeWebhookAddress(url: string): Promise<{
  hostname: string;
  address: string;
  family: number;
}> {
  const parsedUrl = new URL(url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error('Webhook URL must use HTTP(S) without credentials');
  }

  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Webhook URL resolves to a non-public address');
  }

  return { hostname, ...addresses[0] };
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

    let timeout: NodeJS.Timeout | undefined;
    let dispatcher: Agent | undefined;
    try {
      const vettedAddress = await resolveSafeWebhookAddress(registration.url);
      const pinnedLookup = (
        requestedHostname: string,
        options: { all?: boolean } | number,
        callback: (_error: NodeJS.ErrnoException | null, _address: string | { address: string; family: number }[], _family?: number) => void,
      ) => {
        if (requestedHostname !== vettedAddress.hostname || !isPublicAddress(vettedAddress.address)) {
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
      timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

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
        dispatcher,
      } as RequestInit & { dispatcher: Agent });

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
    } finally {
      if (timeout) clearTimeout(timeout);
      if (dispatcher) void dispatcher.destroy();
    }

    this.deliveryLog.push(attempt);

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
