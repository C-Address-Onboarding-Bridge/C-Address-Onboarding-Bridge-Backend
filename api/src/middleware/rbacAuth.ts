import crypto from 'crypto';
import { Response, NextFunction, Request as ExpressRequest } from 'express';
import { logger } from '../logger';
import { getPool } from '../services/db';

export type PermissionScope =
  | 'quote:read'
  | 'fund:write'
  | 'status:read'
  | 'offramp:write'
  | 'cex:read'
  | 'transactions:read'
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

// ─── In-memory store (primary — used for fast lookups and as fallback) ──────────
// Keys are stored both here AND in Postgres. On boot, seedLegacyKeys() also
// populates this map for env-provided keys without round-tripping the DB.
const keyStore = new Map<string, ApiKeyRecord>();

// Short-lived cache: maps keyHash → ApiKeyRecord so repeated requests don't
// re-query the DB. Cleared on revoke/update.
const hashCache = new Map<string, ApiKeyRecord>();

const auditLog: Array<{ ts: number; keyId: string; ip: string; path: string; method: string }> = [];

// ─── Utilities ─────────────────────────────────────────────────────────────────

function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function generateId(): string {
  return `key_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function matchesCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr;
  const [network, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);

  if (ip.includes(':') || network.includes(':')) {
    const ipNum = ipv6ToBigInt(ip);
    const netNum = ipv6ToBigInt(network);
    if (ipNum === null || netNum === null) return false;
    const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
    return (ipNum & mask) === (netNum & mask);
  }

  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
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

function ipv6ToBigInt(ip: string): bigint | null {
  if (!ip.includes(':')) return null;

  let groups: string[];
  if (ip.includes('::')) {
    const [left, right] = ip.split('::');
    if (left.includes('::') || right.includes('::')) return null;
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const missing = 8 - (leftParts.length + rightParts.length);
    if (missing < 0) return null;
    groups = [...leftParts, ...Array(missing).fill('0'), ...rightParts];
  } else {
    groups = ip.split(':');
  }

  if (groups.length > 0 && groups[groups.length - 1].includes('.')) {
    const v4Num = ipToNum(groups.pop() as string);
    if (v4Num === null) return null;
    groups.push(((v4Num >>> 16) & 0xffff).toString(16));
    groups.push((v4Num & 0xffff).toString(16));
  }

  if (groups.length !== 8) return null;

  let result = 0n;
  for (const g of groups) {
    if (g === '' || !/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    result = (result << 16n) | BigInt(parseInt(g, 16));
  }
  return result;
}

function isIpAllowed(ip: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true;
  return whitelist.some((cidr) => matchesCidr(ip, cidr));
}

// ─── DB helpers ────────────────────────────────────────────────────────────────

function recordToRow(r: ApiKeyRecord): Record<string, unknown> {
  return {
    id: r.id,
    key_hash: r.keyHash,
    name: r.name,
    created_by: r.createdBy,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    last_used_at: r.lastUsedAt,
    scopes: JSON.stringify(r.scopes),
    ip_whitelist: JSON.stringify(r.ipWhitelist),
    expires_at: r.expiresAt,
    rate_limit: r.rateLimit,
    revoked: r.revoked ? 1 : 0,
  };
}

// eslint-disable-next-line no-unused-vars
function rowToRecord(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: String(row['id']),
    keyHash: String(row['key_hash']),
    name: String(row['name']),
    createdBy: String(row['created_by']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    lastUsedAt: row['last_used_at'] != null ? Number(row['last_used_at']) : null,
    scopes: JSON.parse(String(row['scopes'])) as PermissionScope[],
    ipWhitelist: JSON.parse(String(row['ip_whitelist'])),
    expiresAt: row['expires_at'] != null ? Number(row['expires_at']) : null,
    rateLimit: (row['rate_limit'] as ApiKeyRecord['rateLimit']) ?? 'standard',
    revoked: Number(row['revoked']) === 1,
  };
}

/**
 * Persist a key record to Postgres. Best-effort — failures are logged but do not
 * prevent in-memory operation.
 */
function persistRecord(record: ApiKeyRecord): void {
  const pool = getPool();
  if (!pool) return;

  const row = recordToRow(record);
  pool
    .query(
      `INSERT INTO api_keys
         (id, key_hash, name, created_by, created_at, updated_at, last_used_at,
          scopes, ip_whitelist, expires_at, rate_limit, revoked)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         name         = EXCLUDED.name,
         updated_at   = EXCLUDED.updated_at,
         last_used_at = EXCLUDED.last_used_at,
         scopes       = EXCLUDED.scopes,
         ip_whitelist = EXCLUDED.ip_whitelist,
         expires_at   = EXCLUDED.expires_at,
         rate_limit   = EXCLUDED.rate_limit,
         revoked      = EXCLUDED.revoked`,
      [
        row['id'], row['key_hash'], row['name'], row['created_by'],
        row['created_at'], row['updated_at'], row['last_used_at'],
        row['scopes'], row['ip_whitelist'], row['expires_at'],
        row['rate_limit'], row['revoked'],
      ],
    )
    .catch((err: unknown) => {
      logger.warn({ err, keyId: record.id }, 'rbacAuth: failed to persist key to DB (non-fatal)');
    });
}


// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a new API key, persist it to Postgres (when available), and return
 * both the raw key (shown once) and the stored record.
 */
export function createApiKey(input: CreateKeyInput): { rawKey: string; record: ApiKeyRecord } {
  const rawKey = `cab_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = hashKey(rawKey);
  const now = Date.now();

  const record: ApiKeyRecord = {
    id: generateId(),
    keyHash,
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
  hashCache.set(keyHash, record);
  persistRecord(record);

  return { rawKey, record };
}

/**
 * Revoke a key by ID. Updates both the in-memory store and Postgres.
 */
export function revokeApiKey(id: string): boolean {
  const record = keyStore.get(id);
  if (!record) return false;

  record.revoked = true;
  record.updatedAt = Date.now();
  keyStore.set(id, record);

  // Invalidate hash cache entry
  hashCache.delete(record.keyHash);

  persistRecord(record);
  return true;
}

/**
 * List all keys without exposing keyHash.
 */
export function listApiKeys(): Omit<ApiKeyRecord, 'keyHash'>[] {
  return Array.from(keyStore.values()).map((r) => {
    const rec: Omit<ApiKeyRecord, 'keyHash'> = {
      id: r.id, name: r.name, createdBy: r.createdBy, createdAt: r.createdAt,
      updatedAt: r.updatedAt, lastUsedAt: r.lastUsedAt, scopes: r.scopes,
      ipWhitelist: r.ipWhitelist, expiresAt: r.expiresAt, rateLimit: r.rateLimit,
      revoked: r.revoked,
    };
    return rec;
  });
}

/**
 * Get a single key by ID without exposing keyHash.
 */
export function getApiKey(id: string): Omit<ApiKeyRecord, 'keyHash'> | undefined {
  const record = keyStore.get(id);
  if (!record) return undefined;
  const rec: Omit<ApiKeyRecord, 'keyHash'> = {
    id: record.id, name: record.name, createdBy: record.createdBy,
    createdAt: record.createdAt, updatedAt: record.updatedAt, lastUsedAt: record.lastUsedAt,
    scopes: record.scopes, ipWhitelist: record.ipWhitelist, expiresAt: record.expiresAt,
    rateLimit: record.rateLimit, revoked: record.revoked,
  };
  return rec;
}

/**
 * Partially update a key's mutable fields.
 */
export function updateApiKey(
  id: string,
  patch: Partial<Pick<ApiKeyRecord, 'name' | 'scopes' | 'ipWhitelist' | 'expiresAt' | 'rateLimit'>>,
): boolean {
  const record = keyStore.get(id);
  if (!record) return false;

  Object.assign(record, patch, { updatedAt: Date.now() });
  keyStore.set(id, record);

  // Invalidate hash cache so the updated record is served on next request
  hashCache.delete(record.keyHash);

  persistRecord(record);
  return true;
}

/**
 * Resolve a raw API key to its record. Checks the in-memory hash cache first,
 * then the keyStore, then falls back to a synchronous scan (legacy path).
 * Returns undefined when the key is not found.
 *
 * Note: async DB lookup is intentionally omitted from this synchronous path
 * because rbacAuth middleware is used synchronously in Express. Keys created
 * through the API are always populated in keyStore at creation time.
 */
export function resolveRecord(rawKey: string): ApiKeyRecord | undefined {
  const keyHash = hashKey(rawKey);

  // 1. Check hash cache
  const cached = hashCache.get(keyHash);
  if (cached) return cached;

  // 2. Scan keyStore by hash (in-memory)
  for (const record of keyStore.values()) {
    if (record.keyHash === keyHash) {
      hashCache.set(keyHash, record);
      return record;
    }
  }

  return undefined;
}

declare module 'express-serve-static-core' {
  // eslint-disable-next-line no-unused-vars
  // eslint-disable-next-line no-unused-vars
  interface Request {
    apiKeyRecord?: Omit<ApiKeyRecord, 'keyHash'>;
    resolvedScopes?: PermissionScope[];
  }
}

/**
 * Returns an Express middleware that enforces the specified scopes. The request
 * must have already been processed by rbacAuth (which attaches apiKeyRecord).
 */
export function requireScopes(...required: PermissionScope[]) {
  return (req: ExpressRequest, res: Response, next: NextFunction): void => {
    const record = req.apiKeyRecord;
    if (!record) {
      res.status(401).json({ error: 'unauthorized', message: 'authentication required' });
      return;
    }

    const missing = required.filter((s) => !record.scopes.includes(s));
    if (missing.length > 0) {
      res.status(403).json({ error: 'forbidden', message: `missing required scopes: ${missing.join(', ')}` });
      return;
    }

    next();
  };
}

/**
 * Core authentication middleware. Reads the raw API key from the X-API-Key header,
 * resolves it via the in-memory store (populated from Postgres on startup / at key
 * creation), validates expiry, revocation status, and IP whitelist, then attaches
 * the record to req.apiKeyRecord.
 */
export function rbacAuth(req: ExpressRequest, res: Response, next: NextFunction): void {
  const rawKey =
    (req.headers['x-api-key'] as string | undefined) ??
    (req.headers['authorization'] as string | undefined)?.replace(/^Bearer\s+/i, '');

  if (!rawKey) {
    res.status(401).json({ error: 'unauthorized', message: 'API key required' });
    return;
  }

  const record = resolveRecord(rawKey);
  if (!record) {
    res.status(401).json({ error: 'unauthorized', message: 'invalid API key' });
    return;
  }

  if (record.revoked) {
    res.status(401).json({ error: 'unauthorized', message: 'API key has been revoked' });
    return;
  }

  if (record.expiresAt !== null && record.expiresAt < Date.now()) {
    res.status(401).json({ error: 'unauthorized', message: 'API key has expired' });
    return;
  }

  const ip = req.ip ?? '';
  if (!isIpAllowed(ip, record.ipWhitelist)) {
    res.status(403).json({ error: 'forbidden', message: 'IP address not allowed' });
    return;
  }

  // Attach record (without keyHash) to the request
  const safeRecord: Omit<ApiKeyRecord, 'keyHash'> = {
    id: record.id, name: record.name, createdBy: record.createdBy,
    createdAt: record.createdAt, updatedAt: record.updatedAt, lastUsedAt: record.lastUsedAt,
    scopes: record.scopes, ipWhitelist: record.ipWhitelist, expiresAt: record.expiresAt,
    rateLimit: record.rateLimit, revoked: record.revoked,
  };
  req.apiKeyRecord = safeRecord;
  req.resolvedScopes = record.scopes;

  // Update last-used timestamp — best effort, non-blocking
  record.lastUsedAt = Date.now();
  const pool = getPool();
  if (pool) {
    pool
      .query(`UPDATE api_keys SET last_used_at = $1 WHERE id = $2`, [record.lastUsedAt, record.id])
      .catch((err: unknown) => logger.debug({ err }, 'rbacAuth: failed to update last_used_at'));
  }

  // Append to in-memory audit log
  auditLog.push({
    ts: Date.now(),
    keyId: record.id,
    ip,
    path: req.path,
    method: req.method,
  });

  next();
}

/**
 * Return a snapshot of the in-memory audit log.
 */
export function getAuditLog(): typeof auditLog {
  return [...auditLog];
}

/**
 * Seed "legacy" plain-text API keys from the environment (e.g. config.apiKeys).
 * These are stored with full admin scopes so existing integrations keep working.
 * Calling this function multiple times with the same key is idempotent.
 */
export function seedLegacyKeys(rawKeys: string[]): void {
  for (const rawKey of rawKeys) {
    const keyHash = hashKey(rawKey);

    // Skip if already seeded (by hash)
    let alreadyExists = hashCache.has(keyHash);
    if (!alreadyExists) {
      for (const r of keyStore.values()) {
        if (r.keyHash === keyHash) {
          alreadyExists = true;
          break;
        }
      }
    }
    if (alreadyExists) continue;

    const now = Date.now();
    const record: ApiKeyRecord = {
      id: `legacy_${hashKey(rawKey).slice(0, 16)}`,
      keyHash,
      name: `legacy-key-${rawKey.slice(0, 8)}`,
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      scopes: [
        'quote:read',
        'fund:write',
        'status:read',
        'offramp:write',
        'cex:read',
        'transactions:read',
        'admin:keys',
      ],
      ipWhitelist: [],
      expiresAt: null,
      rateLimit: 'standard',
      revoked: false,
    };

    keyStore.set(record.id, record);
    hashCache.set(keyHash, record);
    persistRecord(record);
  }
}
