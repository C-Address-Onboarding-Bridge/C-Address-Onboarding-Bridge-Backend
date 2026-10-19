import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import net from 'net';
import { requireScope } from '../middleware/rbacAuth';
import { isBlockedIp, webhookDeliveryService } from '../services/webhookDelivery';
import { logger } from '../utils/logger';

const router = Router();

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
]);

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (net.isIP(host) && isBlockedIp(host)) return true;
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
  apiKey: string;
  createdAt: string;
  active: boolean;
}

const registrations = new Map<string, WebhookRegistration>();

router.post('/register', requireScope('webhooks:write'), (req: Request, res: Response) => {
  const { url, events } = req.body ?? {};

// Delete a registration owned by the calling key
webhookAdminRouter.delete('/registrations/:id', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const apiKey = req.headers['x-api-key'] as string;
  const registration = webhookDeliveryService.getRegistration(req.params.id);
  if (!registration || registration.apiKey !== apiKey) {
    res.status(404).json({ error: 'not_found', message: 'registration not found' });
    return;
  }
  webhookDeliveryService.unregister(req.params.id);
  res.json({ status: 'deleted' });
});

// DLQ inspection — list failed deliveries for the calling key
webhookAdminRouter.get('/dlq', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const apiKey = req.headers['x-api-key'] as string;
  const entries = webhookDeliveryService
    .getDLQ()
    .filter((e) => e.registration.apiKey === apiKey)
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
webhookAdminRouter.get('/dlq/:id', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const apiKey = req.headers['x-api-key'] as string;
  const entry = webhookDeliveryService.getDLQEntry(req.params.id);
  if (!entry || entry.registration.apiKey !== apiKey) {
    res.status(404).json({ error: 'not_found', message: 'DLQ entry not found' });
    return;
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    return res.status(400).json({ error: 'url must be an https URL' });
  }
  if (!Array.isArray(events) || events.length === 0 || !events.every((e) => typeof e === 'string')) {
    return res.status(400).json({ error: 'events must be a non-empty array of strings' });
  }

// Remove a DLQ entry after manual inspection / resolution
webhookAdminRouter.delete('/dlq/:id', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const apiKey = req.headers['x-api-key'] as string;
  const entry = webhookDeliveryService.getDLQEntry(req.params.id);
  if (!entry || entry.registration.apiKey !== apiKey) {
    res.status(404).json({ error: 'not_found', message: 'DLQ entry not found' });
    return;
  }
  webhookDeliveryService.deleteDLQEntry(req.params.id);
  res.json({ status: 'deleted' });
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
    apiKey: apiKeyId,
    createdAt: new Date().toISOString(),
    active: true,
  };

  registrations.set(registration.id, registration);
  logger.info('webhook registration created', { id: registration.id, url });

  return res.status(201).json({ id: registration.id, url: registration.url, events: registration.events });
});

router.get('/', requireScope('webhooks:read'), (_req: Request, res: Response) => {
  const list = Array.from(registrations.values()).map(({ apiKey, ...rest }) => rest);
  return res.json({ registrations: list });
});

// Delivery log — scoped to the calling key's registrations
webhookAdminRouter.get('/log', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const apiKey = req.headers['x-api-key'] as string;
  const registrationIds = new Set(
    webhookDeliveryService.getRegistrationsByApiKey(apiKey).map((r) => r.id),
  );
  const attempts = webhookDeliveryService
    .getDeliveryLog()
    .filter((a) => registrationIds.has(a.registrationId));
  res.json({ attempts });
router.delete('/:id', requireScope('webhooks:write'), (req: Request, res: Response) => {
  const removed = registrations.delete(req.params.id);
  if (!removed) {
    return res.status(404).json({ error: 'registration not found' });
  }
  return res.status(204).send();
});

export { router as webhookAdminRouter, registrations as webhookRegistrations };
