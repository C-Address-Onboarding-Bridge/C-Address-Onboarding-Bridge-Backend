import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import net from 'net';
import { requireScopes } from '../middleware/rbacAuth';
import { isBlockedIp, webhookDeliveryService } from '../services/webhookDelivery';

export const webhookAdminRouter = Router();

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata']);

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  return net.isIP(host) !== 0 && isBlockedIp(host);
}

function isSafeWebhookUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') return false;
  return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !isBlockedHost(parsed.hostname);
}

const registerSchema = z.object({
  url: z
    .string()
    .url('callback URL must be a valid URL')
    .refine(isSafeWebhookUrl, 'callback URL must not target a private, loopback, link-local or metadata address'),
  secret: z.string().min(16, 'secret must be at least 16 characters'),
  events: z.array(z.string().min(1)).min(1, 'at least one event required').default(['*']),
});

function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

webhookAdminRouter.post(
  '/register',
  requireScopes('admin:keys'),
  asyncHandler(async (req, res) => {
    const apiKeyId = req.apiKeyRecord?.id;
    if (!apiKeyId) {
      res.status(401).json({ error: 'missing API key record' });
      return;
    }

    const body = registerSchema.parse(req.body);
    const registration = await webhookDeliveryService.register({ ...body, apiKeyId });
    res.status(201).json({
      id: registration.id,
      url: registration.url,
      events: registration.events,
      createdAt: registration.createdAt,
    });
  }),
);

webhookAdminRouter.get(
  '/registrations',
  requireScopes('admin:keys'),
  asyncHandler(async (req, res) => {
    const apiKeyId = req.apiKeyRecord?.id ?? '';
    const registrations = await webhookDeliveryService.getRegistrationsByApiKeyId(apiKeyId);
    res.json({
      registrations: registrations.map((registration) => ({
        id: registration.id,
        url: registration.url,
        events: registration.events,
        createdAt: registration.createdAt,
      })),
    });
  }),
);

webhookAdminRouter.delete(
  '/registrations/:id',
  requireScopes('admin:keys'),
  asyncHandler(async (req, res) => {
    const apiKeyId = req.apiKeyRecord?.id ?? '';
    const registration = await webhookDeliveryService.getRegistration(req.params.id);
    if (!registration || registration.apiKeyId !== apiKeyId) {
      res.status(404).json({ error: 'not_found', message: 'registration not found' });
      return;
    }
    if (!(await webhookDeliveryService.unregister(req.params.id))) {
      res.status(404).json({ error: 'not_found', message: 'registration not found' });
      return;
    }
    res.status(204).send();
  }),
);

webhookAdminRouter.get(
  '/dlq',
  requireScopes('admin:keys'),
  asyncHandler(async (req, res) => {
    const apiKeyId = req.apiKeyRecord?.id ?? '';
    const entries = (await webhookDeliveryService.getDLQ())
      .filter((entry) => entry.registration.apiKeyId === apiKeyId)
      .map((entry) => ({
        id: entry.id,
        registrationId: entry.registration.id,
        url: entry.registration.url,
        event: entry.event,
        failedAt: entry.failedAt,
        attemptCount: entry.attempts.length,
      }));
    res.json({ entries });
  }),
);

webhookAdminRouter.get(
  '/dlq/:id',
  requireScopes('admin:keys'),
  asyncHandler(async (req, res) => {
    const apiKeyId = req.apiKeyRecord?.id ?? '';
    const entry = await webhookDeliveryService.getDLQEntry(req.params.id);
    if (!entry || entry.registration.apiKeyId !== apiKeyId) {
      res.status(404).json({ error: 'not_found', message: 'DLQ entry not found' });
      return;
    }
    const safeRegistration = {
      id: entry.registration.id,
      url: entry.registration.url,
      events: entry.registration.events,
      createdAt: entry.registration.createdAt,
    };
    res.json({ ...entry, registration: safeRegistration });
  }),
);

webhookAdminRouter.delete(
  '/dlq/:id',
  requireScopes('admin:keys'),
  asyncHandler(async (req, res) => {
    const apiKeyId = req.apiKeyRecord?.id ?? '';
    const entry = await webhookDeliveryService.getDLQEntry(req.params.id);
    if (!entry || entry.registration.apiKeyId !== apiKeyId) {
      res.status(404).json({ error: 'not_found', message: 'DLQ entry not found' });
      return;
    }
    if (!(await webhookDeliveryService.deleteDLQEntry(req.params.id))) {
      res.status(404).json({ error: 'not_found', message: 'DLQ entry not found' });
      return;
    }
    res.json({ status: 'deleted' });
  }),
);

webhookAdminRouter.get(
  '/stats',
  requireScopes('admin:keys'),
  asyncHandler(async (_req, res) => {
    res.json(await webhookDeliveryService.getStats());
  }),
);

webhookAdminRouter.get(
  '/log',
  requireScopes('admin:keys'),
  asyncHandler(async (req, res) => {
    const apiKeyId = req.apiKeyRecord?.id ?? '';
    const [registrations, attempts] = await Promise.all([
      webhookDeliveryService.getRegistrationsByApiKeyId(apiKeyId),
      webhookDeliveryService.getDeliveryLog(),
    ]);
    const registrationIds = new Set(registrations.map((registration) => registration.id));
    res.json({ attempts: attempts.filter((attempt) => registrationIds.has(attempt.registrationId)) });
  }),
);
