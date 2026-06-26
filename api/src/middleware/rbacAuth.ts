import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../index';

export type PermissionScope =
  | 'quote:read'
  | 'fund:write'
  | 'status:read'
  | 'offramp:write'
  | 'cex:read'
  | 'admin:keys';

export interface ApiKeyRecord {
  id: string;
  keyHash: string;
  name: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  scopes: PermissionScope[];
  ipWhitelist: string[];
  expiresAt: number | null;
  rateLimit: 'low' | 'standard' | 'high';
  revoked: boolean;
}

export interface CreateKeyInput {
  name: string;
  createdBy: string;
  scopes: PermissionScope[];
  ipWhitelist?: string[];
  expiresAt?: number | null;
  rateLimit?: 'low' | 'standard' | 'high';
}

const keyStore = new Map<string, ApiKeyRecord>();
const auditLog: Array<{ ts: number; keyId: string; ip: string; path: string; method: string }> = [];

function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function matchesCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr;
  const [network, bits] = cidr.split('/');
  const mask = ~((1 << (32 - parseInt(bits, 10))) - 1) >>> 0;
  const ipNum = ipToNum(ip);
  const netNum = ipToNum(network);
  if (ipNum === null || netNum === null) return false;
  return (ipNum & mask) === (netNum & mask);
}

function ipToNum(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return parts.reduce((acc, p) => (acc << 8) + parseInt(p, 10), 0) >>> 0;
}

function isIpAllowed(ip: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true;
  return whitelist.some((cidr) => matchesCidr(ip, cidr));
}

export function createApiKey(input: CreateKeyInput): { rawKey: string; record: ApiKeyRecord } {
  const rawKey = `cab_${crypto.randomBytes(32).toString('hex')}`;
  const now = Date.now();
  const record: ApiKeyRecord = {
    id: crypto.randomUUID(),
    keyHash: hashKey(rawKey),
    name: input.name,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    scopes: input.scopes,
    ipWhitelist: input.ipWhitelist ?? [],
    expiresAt: input.expiresAt ?? null,
    rateLimit: input.rateLimit ?? 'standard',
    revoked: false,
  };
  keyStore.set(record.id, record);
  return { rawKey, record };
}

export function revokeApiKey(id: string): boolean {
  const record = keyStore.get(id);
  if (!record) return false;
  record.revoked = true;
  record.updatedAt = Date.now();
  return true;
}

export function listApiKeys(): Omit<ApiKeyRecord, 'keyHash'>[] {
  return [...keyStore.values()].map(({ keyHash: _h, ...rest }) => rest);
}

export function getApiKey(id: string): Omit<ApiKeyRecord, 'keyHash'> | undefined {
  const record = keyStore.get(id);
  if (!record) return undefined;
  const { keyHash: _h, ...rest } = record;
  return rest;
}

export function updateApiKey(
  id: string,
  patch: Partial<Pick<ApiKeyRecord, 'name' | 'scopes' | 'ipWhitelist' | 'expiresAt' | 'rateLimit'>>,
): boolean {
  const record = keyStore.get(id);
  if (!record) return false;
  Object.assign(record, patch, { updatedAt: Date.now() });
  return true;
}

function resolveRecord(rawKey: string): ApiKeyRecord | undefined {
  const hash = hashKey(rawKey);
  for (const record of keyStore.values()) {
    if (record.keyHash === hash) return record;
  }
  return undefined;
}

declare module 'express-serve-static-core' {
  interface Request {
    apiKeyRecord?: Omit<ApiKeyRecord, 'keyHash'>;
    resolvedScopes?: PermissionScope[];
  }
}

export function requireScopes(...required: PermissionScope[]) {
  return function scopeGuard(req: Request, res: Response, next: NextFunction): void {
    const record = req.apiKeyRecord;
    if (!record) {
      res.status(401).json({ error: 'unauthorized', message: 'API key required' });
      return;
    }
    const missing = required.filter((s) => !record.scopes.includes(s));
    if (missing.length > 0) {
      logger.warn({ keyId: record.id, required, missing, path: req.path }, 'insufficient scopes');
      res.status(403).json({ error: 'forbidden', message: 'insufficient permissions', required, missing });
      return;
    }
    next();
  };
}

export function rbacAuth(req: Request, res: Response, next: NextFunction): void {
  const rawKey = req.headers['x-api-key'] as string | undefined;
  const ip = req.ip ?? 'unknown';

  if (!rawKey) {
    res.status(401).json({ error: 'unauthorized', message: 'missing API key' });
    return;
  }

  const record = resolveRecord(rawKey);

  if (!record || record.revoked) {
    logger.warn({ ip, path: req.path }, 'invalid or revoked API key presented');
    res.status(401).json({ error: 'unauthorized', message: 'invalid or revoked API key' });
    return;
  }

  if (record.expiresAt !== null && Date.now() > record.expiresAt) {
    logger.warn({ ip, keyId: record.id, path: req.path }, 'expired API key presented');
    res.status(401).json({ error: 'unauthorized', message: 'API key has expired' });
    return;
  }

  if (!isIpAllowed(ip, record.ipWhitelist)) {
    logger.warn({ ip, keyId: record.id, whitelist: record.ipWhitelist }, 'IP not in API key whitelist');
    res.status(403).json({ error: 'forbidden', message: 'IP address not permitted for this key' });
    return;
  }

  record.lastUsedAt = Date.now();
  auditLog.push({ ts: Date.now(), keyId: record.id, ip, path: req.path, method: req.method });

  const { keyHash: _h, ...rest } = record;
  req.apiKeyRecord = rest;
  req.resolvedScopes = record.scopes;
  next();
}

export function getAuditLog(): typeof auditLog {
  return [...auditLog];
}

export function seedLegacyKeys(rawKeys: string[]): void {
  for (const key of rawKeys) {
    const existing = resolveRecord(key);
    if (existing) continue;
    const now = Date.now();
    const record: ApiKeyRecord = {
      id: crypto.randomUUID(),
      keyHash: hashKey(key),
      name: 'legacy',
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      scopes: ['quote:read', 'fund:write', 'status:read', 'offramp:write', 'cex:read'],
      ipWhitelist: [],
      expiresAt: null,
      rateLimit: 'standard',
      revoked: false,
    };
    keyStore.set(record.id, record);
  }
}
