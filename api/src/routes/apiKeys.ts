import { Router, Request, Response } from 'express';
import {
  createApiKey,
  revokeApiKey,
  listApiKeys,
  getApiKey,
  updateApiKey,
  getAuditLog,
  requireScopes,
  PermissionScope,
} from '../middleware/rbacAuth';

export const apiKeysRouter = Router();

apiKeysRouter.post('/', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const { name, scopes, ipWhitelist, expiresAt, rateLimit } = req.body as {
    name?: string;
    scopes?: PermissionScope[];
    ipWhitelist?: string[];
    expiresAt?: number | null;
    rateLimit?: 'low' | 'standard' | 'high';
  };

  if (!name || !Array.isArray(scopes) || scopes.length === 0) {
    res.status(400).json({ error: 'bad_request', message: 'name and scopes are required' });
    return;
  }

  const createdBy = req.apiKeyRecord?.id ?? 'unknown';
  const { rawKey, record } = createApiKey({ name, scopes, ipWhitelist, expiresAt, rateLimit, createdBy });

  res.status(201).json({ rawKey, id: record.id, name: record.name, scopes: record.scopes });
});

apiKeysRouter.get('/', requireScopes('admin:keys'), (_req: Request, res: Response) => {
  res.json({ keys: listApiKeys() });
});

apiKeysRouter.get('/audit', requireScopes('admin:keys'), (_req: Request, res: Response) => {
  res.json({ log: getAuditLog() });
});

apiKeysRouter.get('/:id', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const record = getApiKey(req.params.id);
  if (!record) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(record);
});

apiKeysRouter.patch('/:id', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const updated = updateApiKey(req.params.id, req.body as Parameters<typeof updateApiKey>[1]);
  if (!updated) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ status: 'updated' });
});

apiKeysRouter.delete('/:id', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const revoked = revokeApiKey(req.params.id);
  if (!revoked) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ status: 'revoked' });
});
