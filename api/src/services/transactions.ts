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
const adminAuditLog: Array<{ ts: number; action: string; actor: string; details: Record<string, unknown> }> = [];

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

export function getFeeConfig(): FeeConfigState {
  throw new Error('Not implemented: getFeeConfig');
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

export function recordAdminAction(action: string, details: Record<string, unknown>, actor = 'admin') {
  throw new Error('Not implemented: recordAdminAction');
}

export function getAdminAuditLog() {
  throw new Error('Not implemented: getAdminAuditLog');
}
