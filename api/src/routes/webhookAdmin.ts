import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { requireScope } from '../middleware/rbacAuth';
import { webhookDeliveryService } from '../services/webhookDelivery';
import { logger } from '../utils/logger';

const router = Router();

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

  if (typeof url !== 'string' || !url.startsWith('https://')) {
    return res.status(400).json({ error: 'url must be an https URL' });
  }
  if (!Array.isArray(events) || events.length === 0 || !events.every((e) => typeof e === 'string')) {
    return res.status(400).json({ error: 'events must be a non-empty array of strings' });
  }

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

router.delete('/:id', requireScope('webhooks:write'), (req: Request, res: Response) => {
  const removed = registrations.delete(req.params.id);
  if (!removed) {
    return res.status(404).json({ error: 'registration not found' });
  }
  return res.status(204).send();
});

export { router as webhookAdminRouter, registrations as webhookRegistrations };
