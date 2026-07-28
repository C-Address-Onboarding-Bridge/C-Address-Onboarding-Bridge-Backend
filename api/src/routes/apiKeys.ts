import { Router, Request, Response } from 'express';
import { z } from 'zod';
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

const updateApiKeySchema = z
  .object({
    name: z.string().min(1),
    scopes: z.array(
      z.enum(['quote:read', 'fund:write', 'status:read', 'offramp:write', 'cex:read', 'admin:keys']),
    ),
    ipWhitelist: z.array(z.string()),
    expiresAt: z.number().nullable(),
    rateLimit: z.enum(['low', 'standard', 'high']),
  })
  .partial()
  .strict();

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
  const parsed = updateApiKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', message: 'invalid patch body', issues: parsed.error.issues });
    return;
  }

  const updated = updateApiKey(req.params.id, parsed.data);
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
