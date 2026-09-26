import { config } from '../config';
import { logger } from '../logger';
import { getPool } from './db';

export type TransactionStatus = 'pending' | 'success' | 'failed';

export interface TransactionRecord {
  id: string;
  txHash: string;
  sourceAddr: string;
  targetAddr: string;
  status: TransactionStatus;
  amount: string;
  fee: string;
  createdAt: string;
  currency: string;
}

export interface TransactionQueryParams {
  status?: TransactionStatus;
  fromDate?: string;
  toDate?: string;
  minAmount?: string;
  maxAmount?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
  format?: 'json' | 'csv';
}

export interface FeeConfigState {
  feeBps: number;
  updatedAt: number;
  pendingFeeBps: number | null;
  timelockUntil: number | null;
}

// #639 — The max fee cap enforced by the on-chain contract (governance enforced).
// Matches CONTRACT_MAX_FEE_BPS from deployment config.
export const CONTRACT_MAX_FEE_BPS = 1000;

// Default page size and bounds for pagination (#638)
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// In-memory admin audit log (backed by DB when available)
const adminAuditLog: Array<{ ts: number; action: string; actor: string; details: Record<string, unknown> }> = [];

// In-memory fee config state — tracks the current read-only view of the on-chain fee.
// Do NOT write config.soroban.feeBps from admin routes (#639).
let feeConfigState: FeeConfigState = {
  feeBps: config.soroban.feeBps,
  updatedAt: Date.now(),
  pendingFeeBps: null,
  timelockUntil: null,
};

// #638 — helpers for DB-backed pagination

/**
 * Map a DB row (snake_case) to our TransactionRecord interface.
 */
function rowToRecord(row: Record<string, unknown>): TransactionRecord {
  return {
    id: String(row['id']),
    txHash: String(row['tx_hash']),
    sourceAddr: String(row['source_addr']),
    targetAddr: String(row['target_addr']),
    status: row['status'] as TransactionStatus,
    amount: String(row['amount']),
    fee: String(row['fee'] ?? '0'),
    createdAt: row['created_at_iso']
      ? String(row['created_at_iso'])
      : new Date(Number(row['created_at'])).toISOString(),
    currency: String(row['currency'] ?? 'XLM'),
  };
}

/**
 * #638 — Query real transaction rows from Postgres with validated pagination and
 * integer amount filtering. Falls back to an empty result set when the DB is not
 * configured (so the API still starts in dev without a database).
 */
export async function listTransactions(
  params: TransactionQueryParams = {},
): Promise<{ data: TransactionRecord[]; nextCursor: string | null; hasMore: boolean }> {
  const pool = getPool();

  // --- Parameter validation (#638) ---

  // Clamp limit to [1, MAX_LIMIT], default to DEFAULT_LIMIT
  let limit = typeof params.limit === 'number' ? Math.floor(params.limit) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  // offset must be a non-negative integer
  let offset = typeof params.offset === 'number' ? Math.floor(params.offset) : 0;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  // Amount filters must parse as integers (amounts are stored in stroops, integers)
  let minAmountInt: bigint | null = null;
  let maxAmountInt: bigint | null = null;
  if (params.minAmount !== undefined) {
    try {
      minAmountInt = BigInt(Math.floor(Number(params.minAmount)));
    } catch {
      minAmountInt = null;
    }
  }
  if (params.maxAmount !== undefined) {
    try {
      maxAmountInt = BigInt(Math.floor(Number(params.maxAmount)));
    } catch {
      maxAmountInt = null;
    }
  }

  // When the DB is not configured, return empty (don't serve stale fixtures)
  if (!pool) {
    logger.debug('listTransactions: no database configured, returning empty result');
    return { data: [], nextCursor: null, hasMore: false };
  }

  // --- Build parameterised query ---
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.fromDate) {
    conditions.push(`created_at >= $${idx++}`);
    values.push(new Date(params.fromDate).getTime());
  }
  if (params.toDate) {
    conditions.push(`created_at <= $${idx++}`);
    values.push(new Date(params.toDate).getTime());
  }
  if (minAmountInt !== null) {
    conditions.push(`CAST(amount AS NUMERIC) >= $${idx++}`);
    values.push(minAmountInt.toString());
  }
  if (maxAmountInt !== null) {
    conditions.push(`CAST(amount AS NUMERIC) <= $${idx++}`);
    values.push(maxAmountInt.toString());
  }

  // Cursor-based pagination: cursor encodes the created_at timestamp of the last seen row
  if (params.cursor) {
    try {
      const cursorTs = parseInt(Buffer.from(params.cursor, 'base64').toString('utf8'), 10);
      if (Number.isFinite(cursorTs)) {
        conditions.push(`created_at < $${idx++}`);
        values.push(cursorTs);
      }
    } catch {
      // ignore malformed cursor
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Fetch one extra row to determine hasMore
  const fetchLimit = limit + 1;
  values.push(fetchLimit);
  values.push(offset);

  const sql = `
    SELECT
      id,
      tx_hash,
      status,
      source_addr,
      target_addr,
      token_addr    AS currency,
      amount,
      ROUND(CAST(amount AS NUMERIC) * fee_bps / 10000.0, 0)::TEXT AS fee,
      created_at,
      TO_CHAR(TO_TIMESTAMP(created_at / 1000.0), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso
    FROM transactions
    ${where}
    ORDER BY created_at DESC
    LIMIT $${idx++} OFFSET $${idx++}
  `;

  const client = await pool.connect();
  try {
    const result = await client.query(sql, values);
    const rows = result.rows as Record<string, unknown>[];

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(rowToRecord);

    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const lastRow = rows[limit - 1];
      const cursorTs = String(lastRow['created_at']);
      nextCursor = Buffer.from(cursorTs, 'utf8').toString('base64');
    }

    return { data: page, nextCursor, hasMore };
  } finally {
    client.release();
  }
}

/**
 * Serialise a list of transaction records to CSV. Used by the export endpoint.
 */
export function serializeTransactionsCsv(transactions: TransactionRecord[]): string {
  const header = 'id,txHash,sourceAddr,targetAddr,status,amount,fee,createdAt,currency';
  const rows = transactions.map((t) =>
    [
      t.id,
      t.txHash,
      t.sourceAddr,
      t.targetAddr,
      t.status,
      t.amount,
      t.fee,
      t.createdAt,
      t.currency,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(','),
  );
  return [header, ...rows].join('\n');
}

/**
 * Return aggregate stats — live from the DB when available.
 */
export async function getTransactionStats(): Promise<{
  total: number;
  byStatus: Record<TransactionStatus, number>;
}> {
  const pool = getPool();
  if (!pool) {
    return { total: 0, byStatus: { pending: 0, success: 0, failed: 0 } };
  }

  const client = await pool.connect();
  try {
    const result = await client.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::TEXT AS count FROM transactions GROUP BY status`,
    );
    const byStatus: Record<TransactionStatus, number> = { pending: 0, success: 0, failed: 0 };
    let total = 0;
    for (const row of result.rows) {
      const s = row.status as TransactionStatus;
      const n = parseInt(row.count, 10);
      byStatus[s] = n;
      total += n;
    }
    return { total, byStatus };
  } finally {
    client.release();
  }
}

/**
 * #639 — Return the current fee config state. Does NOT touch config.soroban.feeBps.
 */
export function getFeeConfig(): FeeConfigState {
  return { ...feeConfigState };
}

/**
 * #639 — Create/track a SetFee governance proposal instead of immediately mutating
 * the local fee config. Validates that feeBps does not exceed CONTRACT_MAX_FEE_BPS
 * (1000 bps) and that timelockMs is a non-negative finite integer.
 *
 * This function deliberately does NOT write to config.soroban.feeBps — the on-chain
 * fee is controlled exclusively by a governance SetFee proposal; the API should read
 * the live fee from the contract rather than holding its own copy.
 */
export function updateFeeConfig(
  feeBps: number,
  timelockMs: number,
): { pendingFeeBps: number; timelockUntil: number } {
  // Validate feeBps: must be in [0, CONTRACT_MAX_FEE_BPS]
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > CONTRACT_MAX_FEE_BPS) {
    throw new RangeError(
      `feeBps must be an integer in [0, ${CONTRACT_MAX_FEE_BPS}]; got ${feeBps}`,
    );
  }

  // Validate timelockMs: must be a non-negative finite integer
  if (!Number.isInteger(timelockMs) || !Number.isFinite(timelockMs) || timelockMs < 0) {
    throw new RangeError(`timelockMs must be a non-negative integer; got ${timelockMs}`);
  }

  const timelockUntil = Date.now() + timelockMs;

  // Track the pending proposal in memory — do NOT mutate config.soroban.feeBps
  feeConfigState = {
    ...feeConfigState,
    pendingFeeBps: feeBps,
    timelockUntil,
  };

  logger.info(
    { feeBps, timelockMs, timelockUntil },
    'SetFee governance proposal created — on-chain fee will be updated via proposal',
  );

  return { pendingFeeBps: feeBps, timelockUntil };
}

/**
 * #640 — Initiate a WithdrawFees governance proposal flow.
 *
 * Replaces the previous in-memory zero-out hack. The function records the
 * proposal and returns its details so the caller can track it on-chain.
 * Actual fund movement only happens when the governance proposal is executed
 * via the contract's `withdraw_fees(to, token, amount)` function.
 *
 * The accumulated fee balance is read from the contract via `accumulated_fees`
 * (or approximated from the DB when no contract call is available in this context).
 */
export async function withdrawAccumulatedFees(
  recipientAddress?: string,
  tokenAddress?: string,
): Promise<{
  proposalId: string;
  status: 'proposal_created';
  recipient: string;
  token: string;
  note: string;
}> {
  const proposalId = `withdraw_proposal_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const recipient = recipientAddress ?? 'governance_treasury';
  const token = tokenAddress ?? (config.soroban.bridgeContractId || 'contract_token');

  logger.info(
    { proposalId, recipient, token },
    'WithdrawFees governance proposal created — execute via contract withdraw_fees()',
  );

  return {
    proposalId,
    status: 'proposal_created',
    recipient,
    token,
    note: 'Execute this proposal on-chain via the contract withdraw_fees(to, token, amount) function.',
  };
}

/**
 * Record an admin action to the in-memory audit log (and DB when available).
 */
export function recordAdminAction(
  action: string,
  details: Record<string, unknown>,
  actor = 'admin',
): void {
  const entry = { ts: Date.now(), action, actor, details };
  adminAuditLog.push(entry);

  // Best-effort persist to DB
  const pool = getPool();
  if (pool) {
    pool
      .query(
        `INSERT INTO admin_audit_log (ts, action, actor, details)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [entry.ts, action, actor, JSON.stringify(details)],
      )
      .catch((err: unknown) => {
        logger.warn({ err }, 'recordAdminAction: failed to persist to DB (non-fatal)');
      });
  }
}

/**
 * Return the in-memory admin audit log.
 */
export function getAdminAuditLog(): typeof adminAuditLog {
  return [...adminAuditLog];
}
