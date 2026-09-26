import { config } from '../config';
import { logger } from '../logger';

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

function parseAmount(value: string): number {
  return Number.parseFloat(value);
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

export function getTransactionStats() {
  throw new Error('Not implemented: getTransactionStats');
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

export function updateFeeConfig(feeBps: number, timelockMs: number): { pendingFeeBps: number; timelockUntil: number } {
  const timelockUntil = Date.now() + timelockMs;
  feeConfigState = {
    ...feeConfigState,
    pendingFeeBps: feeBps,
    timelockUntil,
  };
  config.soroban.feeBps = feeBps;
  logger.info({ feeBps, timelockUntil }, 'fee update scheduled');
  return { pendingFeeBps: feeBps, timelockUntil };
}

export function withdrawAccumulatedFees(): { withdrawn: string; status: 'completed' } {
  const withdrawn = accumulatedFees;
  accumulatedFees = '0.00';
  logger.info({ withdrawn }, 'accumulated fees withdrawn');
  return { withdrawn, status: 'completed' };
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
