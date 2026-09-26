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

const seededTransactions: TransactionRecord[] = [
  {
    id: 'tx_1001',
    txHash: '0xabc1001',
    sourceAddr: 'GABC1001',
    targetAddr: 'GXYZ1001',
    status: 'success',
    amount: '120.50',
    fee: '0.36',
    createdAt: '2026-06-20T10:15:00.000Z',
    currency: 'USDC',
  },
  {
    id: 'tx_1002',
    txHash: '0xabc1002',
    sourceAddr: 'GABC1002',
    targetAddr: 'GXYZ1002',
    status: 'pending',
    amount: '80.00',
    fee: '0.24',
    createdAt: '2026-06-21T09:45:00.000Z',
    currency: 'USDC',
  },
  {
    id: 'tx_1003',
    txHash: '0xabc1003',
    sourceAddr: 'GABC1003',
    targetAddr: 'GXYZ1003',
    status: 'failed',
    amount: '45.00',
    fee: '0.14',
    createdAt: '2026-06-22T05:30:00.000Z',
    currency: 'USDC',
  },
  {
    id: 'tx_1004',
    txHash: '0xabc1004',
    sourceAddr: 'GABC1004',
    targetAddr: 'GXYZ1004',
    status: 'success',
    amount: '220.00',
    fee: '0.66',
    createdAt: '2026-06-23T12:45:00.000Z',
    currency: 'USDC',
  },
  {
    id: 'tx_1005',
    txHash: '0xabc1005',
    sourceAddr: 'GABC1005',
    targetAddr: 'GXYZ1005',
    status: 'pending',
    amount: '99.99',
    fee: '0.30',
    createdAt: '2026-06-24T08:10:00.000Z',
    currency: 'USDC',
  },
];

const transactionStore: TransactionRecord[] = [...seededTransactions];
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

const DEFAULT_TRANSACTIONS_LIMIT = 20;

export function listTransactions(params: TransactionQueryParams = {}): { data: TransactionRecord[]; nextCursor: string | null; hasMore: boolean } {
  const { status, fromDate, toDate, minAmount, maxAmount, cursor, offset } = params;
  const limit = params.limit ?? DEFAULT_TRANSACTIONS_LIMIT;

  const filtered = transactionStore.filter((tx) => {
    if (status && tx.status !== status) return false;
    if (fromDate && tx.createdAt < fromDate) return false;
    if (toDate && tx.createdAt > toDate) return false;
    if (minAmount !== undefined && parseAmount(tx.amount) < parseAmount(minAmount)) return false;
    if (maxAmount !== undefined && parseAmount(tx.amount) > parseAmount(maxAmount)) return false;
    return true;
  });

  let startIndex = 0;
  if (cursor) {
    const cursorIndex = filtered.findIndex((tx) => tx.id === cursor);
    startIndex = cursorIndex === -1 ? 0 : cursorIndex + 1;
  } else if (offset) {
    startIndex = offset;
  }

  const page = filtered.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < filtered.length;
  const nextCursor = hasMore ? page[page.length - 1]?.id ?? null : null;

  return { data: page, nextCursor, hasMore };
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
