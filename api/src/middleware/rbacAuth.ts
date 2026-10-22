import crypto from 'crypto';
import net from 'net';
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
const keyHashIndex = new Map<string, ApiKeyRecord>();
const auditLog: Array<{ ts: number; keyId: string; ip: string; path: string; method: string }> = [];
/** Keep the in-memory audit log bounded; oldest entries are dropped first. */
const MAX_AUDIT_LOG_ENTRIES = 10_000;

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
    // #644: validate IPv6 prefix length is in [0, 128]
    if (!Number.isFinite(bits) || bits < 0 || bits > 128) return false;
    const ipNum = ipv6ToBigInt(ip);
    const netNum = ipv6ToBigInt(network);
    if (ipNum === null || netNum === null) return false;
    const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
    return (ipNum & mask) === (netNum & mask);
  }

  // #644: validate IPv4 prefix length is in [0, 32]
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const ipNum = ipToNum(ip);
  const netNum = ipToNum(network);
  if (ipNum === null || netNum === null) return false;
  return (ipNum & mask) === (netNum & mask);
}

// #644: Validate the full IP string with net.isIP before doing bit math, so
// malformed octets like 999.1.1.1 or a.b.c.d are rejected instead of
// silently producing wrong numbers via parseInt / NaN-becomes-0.
function ipToNum(ip: string): number | null {
  if (net.isIP(ip) !== 4) return null;
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

/**
 * #644: Validate that a string is a valid IP address or CIDR notation entry.
 * Accepts:
 *   - IPv4 address (e.g. "1.2.3.4")
 *   - IPv6 address (e.g. "::1")
 *   - IPv4 CIDR with prefix 0–32 (e.g. "10.0.0.0/8")
 *   - IPv6 CIDR with prefix 0–128 (e.g. "2001:db8::/32")
 * Returns false for any malformed input.
 */
export function validateIpOrCidr(entry: string): boolean {
  if (typeof entry !== 'string' || entry.length === 0) return false;

  if (!entry.includes('/')) {
    // Plain IP address — must be valid IPv4 or IPv6.
    return net.isIP(entry) !== 0;
  }

  const slashIndex = entry.lastIndexOf('/');
  const host = entry.slice(0, slashIndex);
  const prefixStr = entry.slice(slashIndex + 1);

  const prefix = parseInt(prefixStr, 10);
  // Prefix must be a finite integer with no extra characters (e.g. "32x" rejected).
  if (!Number.isFinite(prefix) || String(prefix) !== prefixStr) return false;

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    return prefix >= 0 && prefix <= 32;
  } else if (ipVersion === 6) {
    return prefix >= 0 && prefix <= 128;
  }
  return false;
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
  keyHashIndex.set(record.keyHash, record);
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
  return true;
}

/**
 * List all keys without exposing keyHash.
 */
export function listApiKeys(): Omit<ApiKeyRecord, 'keyHash'>[] {
  // Copy the arrays so callers cannot change a stored key's scopes or IP whitelist.
  return Array.from(keyStore.values()).map(({ keyHash, ...rest }) => ({
    ...rest,
    scopes: [...rest.scopes],
    ipWhitelist: [...rest.ipWhitelist],
  }));
}

/**
 * Get a single key by ID without exposing keyHash.
 */
export function getApiKey(id: string): Omit<ApiKeyRecord, 'keyHash'> | undefined {
  const record = keyStore.get(id);
  if (!record) return undefined;
  const { keyHash, ...rest } = record;
  // Copy the arrays so callers cannot change the stored key's scopes or IP whitelist.
  return { ...rest, scopes: [...rest.scopes], ipWhitelist: [...rest.ipWhitelist] };
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
  // Types are erased at runtime: apply only the updatable fields so a caller
  // can never overwrite id, keyHash, revoked, etc. Undefined values are
  // ignored and arrays are copied so later mutation of the patch has no effect.
  if (patch.name !== undefined) record.name = patch.name;
  if (patch.scopes !== undefined) record.scopes = [...patch.scopes];
  if (patch.ipWhitelist !== undefined) record.ipWhitelist = [...patch.ipWhitelist];
  if (patch.expiresAt !== undefined) record.expiresAt = patch.expiresAt;
  if (patch.rateLimit !== undefined) record.rateLimit = patch.rateLimit;
  record.updatedAt = Date.now();
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
  // Header values can arrive as arrays or be empty; hashing a non-string
  // throws, so treat anything but a non-empty string as an unknown key.
  if (typeof rawKey !== 'string' || rawKey.length === 0) return undefined;
  const hash = hashKey(rawKey);
  return keyHashIndex.get(hash);
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
  return (req: Request, res: Response, next: NextFunction): void => {
    const granted = req.resolvedScopes ?? [];
    const missing = required.filter((scope) => !granted.includes(scope));
    if (!req.resolvedScopes || missing.length > 0) {
      // Name the missing scopes so clients can tell which permission to request.
      res.status(403).json({ error: 'insufficient_scope', required, missing });
      return;
    }
    next();
  };
}

export function rbacAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-api-key'];
  const apiKey = Array.isArray(header) ? header[0] : header;
  if (!apiKey) {
    res.status(401).json({ error: 'missing_api_key' });
    return;
  }

  const record = resolveRecord(apiKey);
  if (!record) {
    res.status(401).json({ error: 'invalid_api_key' });
    return;
  }

  if (record.revoked) {
    res.status(401).json({ error: 'revoked_api_key' });
    return;
  }

  if (record.expiresAt && Date.now() > record.expiresAt) {
    res.status(401).json({ error: 'expired_api_key' });
    return;
  }

  const clientIp = req.ip ?? '0.0.0.0';
  if (!isIpAllowed(clientIp, record.ipWhitelist)) {
    res.status(403).json({ error: 'ip_not_allowed' });
    return;
  }

  record.lastUsedAt = Date.now();
  const { keyHash, ...publicRecord } = record;
  req.apiKeyRecord = publicRecord;
  // Copy so downstream middleware cannot alter the stored key's scopes.
  req.resolvedScopes = [...record.scopes];

  auditLog.push({
    ts: Date.now(),
    keyId: record.id,
    ip: clientIp,
    path: req.path,
    method: req.method,
  });
  if (auditLog.length > MAX_AUDIT_LOG_ENTRIES) {
    auditLog.splice(0, auditLog.length - MAX_AUDIT_LOG_ENTRIES);
  }

  next();
}

/**
 * Return a paginated snapshot of the in-memory audit log.
 *
 * #642: Accepts offset and limit parameters so callers do not have to fetch
 * the entire log. Returns { entries, total, offset, limit } so the caller
 * knows how many total entries exist and what window was returned.
 *
 * @param offset - Zero-based index of the first entry to return (default 0).
 * @param limit  - Maximum number of entries to return (default 100).
 */
export function getAuditLog(
  offset: number = 0,
  limit: number = 100,
): {
  entries: Array<{ ts: number; keyId: string; ip: string; path: string; method: string }>;
  total: number;
  offset: number;
  limit: number;
} {
  const total = auditLog.length;
  // Copy each entry: returning the stored objects would let callers rewrite
  // recorded audit history.
  const entries = auditLog.slice(offset, offset + limit).map((entry) => ({ ...entry }));
  return { entries, total, offset, limit };
}

/**
 * Seed "legacy" plain-text API keys from the environment (e.g. config.apiKeys).
 * These are stored with full admin scopes so existing integrations keep working.
 * Calling this function multiple times with the same key is idempotent.
 */
export function seedLegacyKeys(rawKeys: string[]): void {
  const now = Date.now();
  for (const entry of rawKeys) {
    // API_KEYS="k1, k2" would otherwise seed " k2", which never matches a
    // presented key; blank entries must not become valid keys either.
    if (typeof entry !== 'string') continue;
    const rawKey = entry.trim();
    if (rawKey.length === 0) continue;
    const keyHash = hashKey(rawKey);
    if (keyHashIndex.has(keyHash)) continue;

    const record: ApiKeyRecord = {
      id: crypto.randomUUID(),
      keyHash,
      name: `Legacy key`,
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      scopes: ['quote:read', 'status:read', 'cex:read', 'transactions:read'],
      ipWhitelist: [],
      expiresAt: null,
      rateLimit: 'standard',
      revoked: false,
    };
    keyStore.set(record.id, record);
    keyHashIndex.set(keyHash, record);
  }
}
