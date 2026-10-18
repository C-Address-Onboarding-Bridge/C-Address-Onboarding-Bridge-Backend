import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { requireScopes } from '../middleware/rbacAuth';
import { webhookDeliveryService } from '../services/webhookDelivery';

const router = Router();

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
]);

function isBlockedIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  const [a, b] = octets;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (isBlockedIpv4(host)) return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) and other IPv6 loopback/link-local forms
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (host === '::1' || host === '::') return true;
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  return false;
}

function isSafeWebhookUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') return false;
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return !isBlockedHost(parsed.hostname);
}

const registerSchema = z.object({
  url: z
    .string()
    .url('callback URL must be a valid URL')
    .refine(isSafeWebhookUrl, 'callback URL must not target a private, loopback, link-local or metadata address'),
  secret: z.string().min(16, 'secret must be at least 16 characters'),
  events: z.array(z.string().min(1)).min(1, 'at least one event required').default(['*']),
});

interface WebhookRegistration {
  id: string;
  url: string;
  events: string[];
  apiKeyId: string;
  createdAt: string;
  active: boolean;
}

const registrations = new Map<string, WebhookRegistration>();

router.post('/register', requireScopes('webhooks:write'), (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
  }
  const { url, events, secret } = parsed.data;

  // Store the API key *id* rather than the raw key so the plaintext secret is
  // never persisted or written to the audit log as the actor.
  const apiKeyId = req.apiKeyRecord?.id;
  if (!apiKeyId) {
    return res.status(401).json({ error: 'missing API key record' });
  }

  const registration: WebhookRegistration = {
    id: randomUUID(),
    url,
    events,
    apiKeyId,
    createdAt: new Date().toISOString(),
    active: true,
  };

  registrations.set(registration.id, registration);
  webhookDeliveryService.register({ id: registration.id, url, events, apiKeyId, secret });

  return res.status(201).json({ id: registration.id, url: registration.url, events: registration.events });
});

router.get('/', requireScopes('webhooks:read'), (req: Request, res: Response) => {
  const apiKeyId = req.apiKeyRecord?.id;
  if (!apiKeyId) {
    return res.status(401).json({ error: 'missing API key record' });
  }
  const list = Array.from(registrations.values())
    .filter((r) => r.apiKeyId === apiKeyId)
    .map(({ apiKeyId: _apiKeyId, ...rest }) => rest);
  return res.json({ registrations: list });
});

router.delete('/:id', requireScopes('webhooks:write'), (req: Request, res: Response) => {
  const apiKeyId = req.apiKeyRecord?.id;
  if (!apiKeyId) {
    return res.status(401).json({ error: 'missing API key record' });
  }
  const registration = registrations.get(req.params.id);
  if (!registration || registration.apiKeyId !== apiKeyId) {
    return res.status(404).json({ error: 'registration not found' });
  }
  registrations.delete(req.params.id);
  webhookDeliveryService.unregister(req.params.id);
  return res.status(204).send();
});

// DLQ inspection — list failed deliveries for the calling key
router.get('/dlq', requireScopes('webhooks:read'), (req: Request, res: Response) => {
  const apiKeyId = req.apiKeyRecord?.id;
  if (!apiKeyId) {
    return res.status(401).json({ error: 'missing API key record' });
  }
  const entries = webhookDeliveryService
    .getDLQ()
    .filter((e) => e.registration.apiKeyId === apiKeyId)
    .map((e) => ({
      id: e.id,
      registrationId: e.registration.id,
      url: e.registration.url,
      event: e.event,
      failedAt: e.failedAt,
      attemptCount: e.attempts.length,
    }));
  res.json({ entries });
});

// DLQ entry detail — full payload and attempt history
router.get('/dlq/:id', requireScopes('webhooks:read'), (req: Request, res: Response) => {
  const apiKeyId = req.apiKeyRecord?.id;
  if (!apiKeyId) {
    return res.status(401).json({ error: 'missing API key record' });
  }
  const entry = webhookDeliveryService.getDLQEntry(req.params.id);
  if (!entry || entry.registration.apiKeyId !== apiKeyId) {
    res.status(404).json({ error: 'not_found', message: 'DLQ entry not found' });
    return;
  }
  res.json({ entry });
});

// Remove a DLQ entry after manual inspection / resolution
router.delete('/dlq/:id', requireScopes('webhooks:write'), (req: Request, res: Response) => {
  const apiKeyId = req.apiKeyRecord?.id;
  if (!apiKeyId) {
    return res.status(401).json({ error: 'missing API key record' });
  }
  const entry = webhookDeliveryService.getDLQEntry(req.params.id);
  if (!entry || entry.registration.apiKeyId !== apiKeyId) {
    res.status(404).json({ error: 'not_found', message: 'DLQ entry not found' });
    return;
  }
  webhookDeliveryService.deleteDLQEntry(req.params.id);
  res.json({ status: 'deleted' });
});

// Delivery log — scoped to the calling key's registrations
router.get('/log', requireScopes('webhooks:read'), (req: Request, res: Response) => {
  const apiKeyId = req.apiKeyRecord?.id;
  if (!apiKeyId) {
    return res.status(401).json({ error: 'missing API key record' });
  }
  const registrationIds = new Set(
    webhookDeliveryService.getRegistrationsByApiKey(apiKeyId).map((r) => r.id),
  );
  const attempts = webhookDeliveryService
    .getDeliveryLog()
    .filter((a) => registrationIds.has(a.registrationId));
  res.json({ attempts });
});

export { router as webhookAdminRouter, registrations as webhookRegistrations };
