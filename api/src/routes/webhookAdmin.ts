import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { webhookDeliveryService } from '../services/webhookDelivery';
import { requireScopes } from '../middleware/rbacAuth';

export const webhookAdminRouter = Router();

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

// Register a webhook callback URL
webhookAdminRouter.post('/register', requireScopes('admin:keys'), (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = req.headers['x-api-key'] as string;
    const body = registerSchema.parse(req.body);
    const registration = webhookDeliveryService.register({ ...body, apiKey });
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
  const apiKey = req.headers['x-api-key'] as string;
  const registrations = webhookDeliveryService.getRegistrationsByApiKey(apiKey).map((r) => ({
    id: r.id,
    url: r.url,
    events: r.events,
    createdAt: r.createdAt,
  }));
  res.json({ registrations });
});

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
  }
  const { secret: _secret, apiKey: _apiKey, ...safeRegistration } = entry.registration;
  res.json({ ...entry, registration: safeRegistration });
});

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
});

// Webhook health dashboard
webhookAdminRouter.get('/stats', requireScopes('admin:keys'), (_req: Request, res: Response) => {
  res.json(webhookDeliveryService.getStats());
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
});
