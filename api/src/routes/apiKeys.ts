import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  createApiKey,
  revokeApiKey,
  listApiKeys,
  getApiKey,
  updateApiKey,
  getAuditLog,
  requireScopes,
  validateIpOrCidr,
  PermissionScope,
} from '../middleware/rbacAuth';

export const apiKeysRouter = Router();

const PERMISSION_SCOPES: PermissionScope[] = [
  'quote:read',
  'fund:write',
  'status:read',
  'offramp:write',
  'cex:read',
  'cex:withdraw',
  'admin:keys',
  'transactions:read',
  'metrics:read',
];

const patchApiKeySchema = z
  .object({
    name: z.string().min(1),
    scopes: z.array(z.enum(PERMISSION_SCOPES as [PermissionScope, ...PermissionScope[]])).min(1),
    ipWhitelist: z.array(
      z.string().refine(validateIpOrCidr, { message: 'Invalid IP address or CIDR' })
    ),
    expiresAt: z.number().nullable(),
    rateLimit: z.enum(['low', 'standard', 'high']),
  })
  .partial();

const createApiKeySchema = z.object({
  name: z.string().min(1),
  scopes: z.array(z.enum(PERMISSION_SCOPES as [PermissionScope, ...PermissionScope[]])).min(1),
  ipWhitelist: z.array(
    z.string().refine(validateIpOrCidr, { message: 'Invalid IP address or CIDR' })
  ).optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  rateLimit: z.enum(['low', 'standard', 'high']).optional(),
});

// A caller may only grant scopes it itself holds. Without this, any
// admin:keys holder could mint a key with cex:withdraw or admin:keys even
// though it never held those scopes to begin with (privilege escalation).
function disallowedScopes(requested: PermissionScope[], granted: PermissionScope[]): PermissionScope[] {
  return requested.filter((scope) => !granted.includes(scope));
}

apiKeysRouter.post('/', requireScopes('admin:keys'), (req: Request, res: Response, next: NextFunction) => {
  let parsed: z.infer<typeof createApiKeySchema>;
  try {
    parsed = createApiKeySchema.parse(req.body);
  } catch (err) {
    next(err);
    return;
  }

  const { name, scopes, ipWhitelist, expiresAt, rateLimit } = parsed;
  const granted = req.resolvedScopes ?? [];
  const disallowed = disallowedScopes(scopes, granted);
  if (disallowed.length > 0) {
    res.status(403).json({ error: 'insufficient_scope', message: 'cannot grant scopes you do not hold', disallowed });
    return;
  }

  const createdBy = req.apiKeyRecord?.id ?? 'unknown';
  const { rawKey, record } = createApiKey({ name, scopes, ipWhitelist, expiresAt, rateLimit, createdBy });

  res.status(201).json({ rawKey, id: record.id, name: record.name, scopes: record.scopes });
});

// Keys are tenant-scoped: an admin:keys holder can administer only keys it
// created itself, not every tenant's keys platform-wide.
apiKeysRouter.get('/', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const callerId = req.apiKeyRecord?.id ?? '';
  res.json({ keys: listApiKeys().filter((k) => k.createdBy === callerId) });
});

apiKeysRouter.get('/audit', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const callerId = req.apiKeyRecord?.id ?? '';
  const rawOffset = parseInt(req.query.offset as string, 10);
  const rawLimit = parseInt(req.query.limit as string, 10);
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100;
  // Pull a generously sized window from the full log, then filter and
  // re-paginate so the caller only ever sees its own key's activity.
  const ownKeyIds = new Set(listApiKeys().filter((k) => k.createdBy === callerId).map((k) => k.id));
  ownKeyIds.add(callerId);
  const full = getAuditLog(0, 1_000_000);
  const filtered = full.entries.filter((e) => ownKeyIds.has(e.keyId));
  res.json({
    entries: filtered.slice(offset, offset + limit),
    total: filtered.length,
    offset,
    limit,
  });
});

function ownsKey(req: Request, id: string): boolean {
  const record = getApiKey(id);
  if (!record) return false;
  return record.createdBy === (req.apiKeyRecord?.id ?? '');
}

apiKeysRouter.get('/:id', requireScopes('admin:keys'), (req: Request, res: Response) => {
  const record = getApiKey(req.params.id);
  if (!record || record.createdBy !== (req.apiKeyRecord?.id ?? '')) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(record);
});

apiKeysRouter.patch('/:id', requireScopes('admin:keys'), (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!ownsKey(req, req.params.id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const patch = patchApiKeySchema.parse(req.body);
    if (patch.scopes !== undefined) {
      const granted = req.resolvedScopes ?? [];
      const disallowed = disallowedScopes(patch.scopes, granted);
      if (disallowed.length > 0) {
        res.status(403).json({ error: 'insufficient_scope', message: 'cannot grant scopes you do not hold', disallowed });
        return;
      }
    }
    const updated = updateApiKey(req.params.id, patch);
    if (!updated) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ status: 'updated' });
  } catch (err) {
    next(err);
  }
});

apiKeysRouter.delete('/:id', requireScopes('admin:keys'), (req: Request, res: Response) => {
  if (!ownsKey(req, req.params.id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const revoked = revokeApiKey(req.params.id);
  if (!revoked) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ status: 'revoked' });
});
