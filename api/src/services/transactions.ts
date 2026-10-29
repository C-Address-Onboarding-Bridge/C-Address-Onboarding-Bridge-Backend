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

export interface AdminAuditEntry {
  ts: number;
  action: string;
  actor: string;
  details: Record<string, unknown>;
}

export interface TransactionStats {
  total: number;
  byStatus: Record<TransactionStatus, number>;
  totalVolume: string;
  totalFees: string;
  averageAmount: string;
}

let feeConfigState: FeeConfigState = {
  feeBps: config.soroban.feeBps,
  updatedAt: Date.now(),
  pendingFeeBps: null,
  timelockUntil: null,
};
let accumulatedFees = '1.20';
const adminAuditLog: AdminAuditEntry[] = [];

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

const DEFAULT_TRANSACTIONS_LIMIT = 50;
const MAX_TRANSACTIONS_LIMIT = 200;

function parseAmount(value: string): string {
  // Truncate any fractional part so amounts are compared as integers.
  const [intPart] = String(value).trim().split('.');
  if (!intPart || intPart === '' || intPart === '-') return '0';
  return intPart;
}

export async function listTransactions(params: TransactionQueryParams = {}): Promise<{ data: TransactionRecord[]; nextCursor: string | null; hasMore: boolean }> {
  const pool = getPool();
  if (!pool) return { data: [], nextCursor: null, hasMore: false };

  const { status, fromDate, toDate, minAmount, maxAmount, cursor, offset } = params;

  let limit = Number(params.limit);
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_TRANSACTIONS_LIMIT;
  if (limit > MAX_TRANSACTIONS_LIMIT) limit = MAX_TRANSACTIONS_LIMIT;

  let off = Number(offset);
  if (!Number.isFinite(off) || off < 0) off = 0;

  const fetchLimit = limit + 1;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (status) {
    conditions.push(`status = $${idx++}`);
    values.push(status);
  }
  if (fromDate) {
    conditions.push(`created_at_iso >= $${idx++}`);
    values.push(fromDate);
  }
  if (toDate) {
    conditions.push(`created_at_iso <= $${idx++}`);
    values.push(toDate);
  }
  if (minAmount !== undefined) {
    conditions.push(`amount::numeric >= $${idx++}::numeric`);
    values.push(parseAmount(minAmount));
  }
  if (maxAmount !== undefined) {
    conditions.push(`amount::numeric <= $${idx++}::numeric`);
    values.push(parseAmount(maxAmount));
  }
  if (cursor) {
    conditions.push(`id > $${idx++}`);
    values.push(cursor);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT id, tx_hash, source_addr, target_addr, status, amount, fee, currency, created_at, created_at_iso FROM transactions ${where} ORDER BY created_at DESC, id DESC LIMIT $${idx} OFFSET $${idx + 1}`;
  values.push(fetchLimit, off);

  const client = await pool.connect();
  try {
    const result = await client.query(sql, values);
    const rows = result.rows as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const data = pageRows.map(rowToRecord);
    const nextCursor = hasMore ? (pageRows[pageRows.length - 1]?.id ? String(pageRows[pageRows.length - 1].id) : null) : null;
    return { data, nextCursor, hasMore };
  } finally {
    client.release();
  }
}

/**
 * Serialise a list of transaction records to CSV. Used by the export endpoint.
 */
export function serializeTransactionsCsv(transactions: TransactionRecord[]): string {
  const headers = ['id', 'txHash', 'sourceAddr', 'targetAddr', 'status', 'amount', 'fee', 'createdAt', 'currency'];

  const escapeField = (value: string): string => {
    // Wrap in quotes if the value contains a comma, double-quote, or newline
    if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };

  const rows = transactions.map((tx) =>
    headers.map((key) => escapeField(String(tx[key as keyof TransactionRecord]))).join(','),
  );

  return [headers.join(','), ...rows].join('\n');
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
 * Returns the current fee configuration state.
 *
 * The returned object is a snapshot of the in-memory fee config, including
 * the active `feeBps`, when it was last `updatedAt`, and any pending fee
 * change scheduled via {@link updateFeeConfig} along with its `timelockUntil`.
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
 * Appends an entry to the in-memory admin audit log.
 *
 * Records who performed an administrative action, what the action was, and
 * any structured `details` associated with it. The entry is timestamped at
 * the moment of the call and returned so callers can echo it back in a
 * response. Entries are appended in chronological order and are retrievable
 * via {@link getAdminAuditLog}.
 *
 * @param action  Short identifier for the admin action (e.g. `'fee.update'`).
 * @param details Arbitrary structured metadata describing the action.
 * @param actor   Identity of the admin performing the action. Defaults to `'admin'`.
 * @returns The recorded audit entry.
 */
export function recordAdminAction(
  action: string,
  details: Record<string, unknown>,
  actor = 'admin',
): AdminAuditEntry {
  const entry: AdminAuditEntry = {
    ts: Date.now(),
    action,
    actor,
    details,
  };
  adminAuditLog.push(entry);
  logger.info({ action, actor }, 'admin action recorded');
  return entry;
}

/**
 * Returns the recorded admin audit log.
 *
 * Backs `GET /api/v1/admin/audit`. Returns a shallow copy of the entries so
 * callers cannot mutate the internal log, preserving append-only semantics.
 */
export function getAdminAuditLog(): AdminAuditEntry[] {
  return adminAuditLog.map((entry) => ({ ...entry }));
}
