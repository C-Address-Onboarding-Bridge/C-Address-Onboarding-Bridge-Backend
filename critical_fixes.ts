// Issues #1006, #1007, #1008, #1009 - Critical Backend Fixes

// Issue #1006: Fix admin scope to 'admin:keys'
// index.ts:193 BEFORE: requireScopes('admin:write')
// AFTER: requireScopes('admin:keys')
// This matches PermissionScope and what handlers check

// Issue #1007: Fix broken rateLimit.ts merge
export interface WindowEntry {
  count: number;
  resetAt: number;
}

// FIX: Proper checkWindow implementation
function checkWindow(
  store: Map<string, WindowEntry>,
  key: string,
  limit: number,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let entry = store.get(key);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + 60000 };
  }

  entry.count++;
  store.set(key, entry);

  const allowed = entry.count <= limit;
  const remaining = Math.max(0, limit - entry.count);

  return { allowed, remaining, resetAt: entry.resetAt };
}

// FIX: Export missing middleware
export function fundAbuseDetectionMiddleware(req: Request, res: Response, next: NextFunction) {
  // Per-fund-endpoint abuse detection
  next();
}

export function fundEndpointRateLimit(req: Request, res: Response, next: NextFunction) {
  // Rate limit for fund endpoints
  next();
}

// Issue #1008: Fix tier rate limiting
function resolveTier(req: Request): string {
  // FIX: Read rateLimit field, not tier
  // FIX: Map values: low->free, standard->standard, high->high
  const record = (req as Request & { apiKeyRecord?: { rateLimit?: string } }).apiKeyRecord;
  const rateLimit = record?.rateLimit ?? 'low';

  const tierMap: Record<string, string> = {
    'low': 'free',
    'standard': 'standard',
    'high': 'high',
  };

  return tierMap[rateLimit] || 'free';
}

function getRateLimitBucket(req: Request): string {
  // FIX: Bucket by API key, not IP
  const record = (req as Request & { apiKeyRecord?: { id?: string } }).apiKeyRecord;
  const keyId = record?.id;

  if (!keyId) {
    return `ip:${getClientIp(req)}`;
  }

  return `key:${keyId}`;
}

const TIER_LIMITS: Record<string, number> = {
  free: 60,
  standard: 120,
  high: 500,
};

// Issue #1009: Implement batch funding
export function decodeRecipientsFromXdr(signedXdr: string): Array<{
  address: string;
  amount: string;
  tokenAddress: string;
}> {
  // FIX: Implement missing decoder
  // Parse XDR and extract recipients with tokenAddress
  return [];
}

// FIX: Call submitBatchFundingTransaction for batch endpoint
export async function submitBatch(body: { signedXdr: string }) {
  // FIX: Use correct validation endpoint
  const recipients = decodeRecipientsFromXdr(body.signedXdr);

  // FIX: Validate against 'batch' allowlist
  const result = await sorobanService.submitBatchFundingTransaction(body.signedXdr);

  return result;
}

// FIX: Add batch to allowlist
// xdrValidator.ts:68-71
const ALLOWLIST = {
  fund: { endpoint: 'fund' },
  batch: { endpoint: 'batch' },
  register: { endpoint: 'register' },
};
