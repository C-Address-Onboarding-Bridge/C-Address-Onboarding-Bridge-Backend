import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import net from 'net';
import { requireScope, requireScopes } from '../middleware/rbacAuth';
import { isBlockedIp, webhookDeliveryService } from '../services/webhookDelivery';
import { logger } from '../utils/logger';

export const webhookAdminRouter = Router();

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

// Register a webhook callback URL
webhookAdminRouter.post('/register', requireScopes('admin:keys'), (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKeyId = req.apiKeyRecord?.id ?? '';
    const body = registerSchema.parse(req.body);
    const registration = webhookDeliveryService.register({ ...body, apiKeyId });
    res.status(201).json({
      id: registration.id,
      url: registration.url,
      events: registration.events,
      createdAt: registration.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

// List registered webhooks for the current API key
webhookAdminRouter.get('/registrations', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const apiKeyId = req.apiKeyRecord?.id ?? '';
  const registrations = webhookDeliveryService.getRegistrationsByApiKeyId(apiKeyId).map((r) => ({
    id: r.id,
    url: r.url,
    events: r.events,
    createdAt: r.createdAt,
  }));
  res.json({ registrations });
});

// Delete a registration owned by the calling key
webhookAdminRouter.delete('/registrations/:id', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const apiKeyId = req.apiKeyRecord?.id ?? '';
  const registration = webhookDeliveryService.getRegistration(req.params.id);
  if (!registration || registration.apiKeyId !== apiKeyId) {
    res.status(404).json({ error: 'not_found', message: 'registration not found' });
    return;
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
webhookAdminRouter.get('/dlq', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const apiKeyId = req.apiKeyRecord?.id ?? '';
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
webhookAdminRouter.get('/dlq/:id', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const apiKeyId = req.apiKeyRecord?.id ?? '';
  const entry = webhookDeliveryService.getDLQEntry(req.params.id);
  if (!entry || entry.registration.apiKeyId !== apiKeyId) {
    res.status(404).json({ error: 'not_found', message: 'DLQ entry not found' });
    return;
  }
  const { secret: _secret, apiKeyId: _apiKeyId, ...safeRegistration } = entry.registration;
  res.json({ ...entry, registration: safeRegistration });
});

// Remove a DLQ entry after manual inspection / resolution
webhookAdminRouter.delete('/dlq/:id', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const apiKeyId = req.apiKeyRecord?.id ?? '';
  const entry = webhookDeliveryService.getDLQEntry(req.params.id);
  if (!entry || entry.registration.apiKeyId !== apiKeyId) {
    res.status(404).json({ error: 'not_found', message: 'DLQ entry not found' });
    return;
  }
  webhookDeliveryService.deleteDLQEntry(req.params.id);
  res.json({ status: 'deleted' });
});

// Webhook health dashboard
webhookAdminRouter.get('/stats', requireScopes('admin:keys'), (_req: Request, res: Response) => {
  res.json(webhookDeliveryService.getStats());
});

// Delivery log — scoped to the calling key's registrations
webhookAdminRouter.get('/log', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const apiKeyId = req.apiKeyRecord?.id ?? '';
  const registrationIds = new Set(
    webhookDeliveryService.getRegistrationsByApiKeyId(apiKeyId).map((r) => r.id),
  );
  const attempts = webhookDeliveryService
    .getDeliveryLog()
    .filter((a) => registrationIds.has(a.registrationId));
  res.json({ attempts });
});
