import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { webhookDeliveryService } from '../services/webhookDelivery';
import { requireScopes } from '../middleware/rbacAuth';

export const webhookAdminRouter = Router();

const registerSchema = z.object({
  url: z.string().url('callback URL must be a valid URL'),
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
