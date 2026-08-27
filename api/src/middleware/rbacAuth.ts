import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';

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

const keyStore = new Map<string, ApiKeyRecord>();
const auditLog: Array<{ ts: number; keyId: string; ip: string; path: string; method: string }> = [];

function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
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

export function createApiKey(input: CreateKeyInput): { rawKey: string; record: ApiKeyRecord } {
  throw new Error('Not implemented: createApiKey');
}

export function revokeApiKey(id: string): boolean {
  const record = keyStore.get(id);
  if (!record) return false;
  record.revoked = true;
  record.updatedAt = Date.now();
  return true;
}

export function listApiKeys(): Omit<ApiKeyRecord, 'keyHash'>[] {
  throw new Error('Not implemented: listApiKeys');
}

export function getApiKey(id: string): Omit<ApiKeyRecord, 'keyHash'> | undefined {
  throw new Error('Not implemented: getApiKey');
}

export function updateApiKey(
  id: string,
  patch: Partial<Pick<ApiKeyRecord, 'name' | 'scopes' | 'ipWhitelist' | 'expiresAt' | 'rateLimit'>>,
): boolean {
  throw new Error('Not implemented: updateApiKey');
}

export function resolveRecord(rawKey: string): ApiKeyRecord | undefined {
  throw new Error('Not implemented: resolveRecord');
}

declare module 'express-serve-static-core' {
  interface Request {
    apiKeyRecord?: Omit<ApiKeyRecord, 'keyHash'>;
    resolvedScopes?: PermissionScope[];
  }
}

export function requireScopes(...required: PermissionScope[]) {
  throw new Error('Not implemented: requireScopes');
}

export function rbacAuth(req: Request, res: Response, next: NextFunction): void {
  throw new Error('Not implemented: rbacAuth');
}

export function getAuditLog(): typeof auditLog {
  throw new Error('Not implemented: getAuditLog');
}

export function seedLegacyKeys(rawKeys: string[]): void {
  throw new Error('Not implemented: seedLegacyKeys');
}
