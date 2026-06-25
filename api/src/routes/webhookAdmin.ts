import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { webhookDeliveryService } from '../services/webhookDelivery';

export const webhookAdminRouter = Router();

const registerSchema = z.object({
  url: z.string().url('callback URL must be a valid URL'),
  secret: z.string().min(16, 'secret must be at least 16 characters'),
  events: z.array(z.string().min(1)).min(1, 'at least one event required').default(['*']),
});

// Register a webhook callback URL
webhookAdminRouter.post('/register', (req: Request, res: Response, next: NextFunction) => {
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
webhookAdminRouter.get('/registrations', (req: Request, res: Response) => {
  const apiKey = req.headers['x-api-key'] as string;
  const registrations = webhookDeliveryService.getRegistrationsByApiKey(apiKey).map((r) => ({
    id: r.id,
    url: r.url,
    events: r.events,
    createdAt: r.createdAt,
  }));
  res.json({ registrations });
});

// Delete a registration
webhookAdminRouter.delete('/registrations/:id', (req: Request, res: Response) => {
  const deleted = webhookDeliveryService.unregister(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'not_found', message: 'registration not found' });
    return;
  }
  res.json({ status: 'deleted' });
});

// DLQ inspection — list all failed deliveries
webhookAdminRouter.get('/dlq', (_req: Request, res: Response) => {
  const entries = webhookDeliveryService.getDLQ().map((e) => ({
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
webhookAdminRouter.get('/dlq/:id', (req: Request, res: Response) => {
  const entry = webhookDeliveryService.getDLQEntry(req.params.id);
  if (!entry) {
    res.status(404).json({ error: 'not_found', message: 'DLQ entry not found' });
    return;
  }
  res.json(entry);
});

// Remove a DLQ entry after manual inspection / resolution
webhookAdminRouter.delete('/dlq/:id', (req: Request, res: Response) => {
  const deleted = webhookDeliveryService.deleteDLQEntry(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'not_found', message: 'DLQ entry not found' });
    return;
  }
  res.json({ status: 'deleted' });
});

// Webhook health dashboard
webhookAdminRouter.get('/stats', (_req: Request, res: Response) => {
  res.json(webhookDeliveryService.getStats());
});

// Delivery log
webhookAdminRouter.get('/log', (_req: Request, res: Response) => {
  res.json({ attempts: webhookDeliveryService.getDeliveryLog() });
});
