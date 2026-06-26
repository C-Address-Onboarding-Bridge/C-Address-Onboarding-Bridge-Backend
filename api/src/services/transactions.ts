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

export function listTransactions(params: TransactionQueryParams = {}): { data: TransactionRecord[]; nextCursor: string | null; hasMore: boolean } {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const fromDate = params.fromDate ? Date.parse(params.fromDate) : undefined;
  const toDate = params.toDate ? Date.parse(params.toDate) : undefined;
  const minAmount = params.minAmount ? parseAmount(params.minAmount) : undefined;
  const maxAmount = params.maxAmount ? parseAmount(params.maxAmount) : undefined;

  const filtered = transactionStore
    .filter((tx) => (params.status ? tx.status === params.status : true))
    .filter((tx) => (fromDate !== undefined ? new Date(tx.createdAt).getTime() >= fromDate : true))
    .filter((tx) => (toDate !== undefined ? new Date(tx.createdAt).getTime() <= toDate : true))
    .filter((tx) => (minAmount !== undefined ? parseAmount(tx.amount) >= minAmount : true))
    .filter((tx) => (maxAmount !== undefined ? parseAmount(tx.amount) <= maxAmount : true))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  let page = filtered;
  if (params.cursor) {
    const cursorTime = Date.parse(params.cursor);
    page = page.filter((tx) => new Date(tx.createdAt).getTime() < cursorTime);
  } else if (params.offset) {
    page = page.slice(params.offset);
  }

  const hasMore = page.length > limit;
  const slice = page.slice(0, limit);
  const nextCursor = hasMore ? slice[slice.length - 1]?.createdAt ?? null : null;

  return { data: slice, nextCursor, hasMore };
}

export function serializeTransactionsCsv(transactions: TransactionRecord[]): string {
  const header = ['id', 'txHash', 'status', 'amount', 'fee', 'createdAt', 'currency'];
  const rows = transactions.map((tx) => [tx.id, tx.txHash, tx.status, tx.amount, tx.fee, tx.createdAt, tx.currency]);
  return [header.join(','), ...rows.map((row) => row.join(','))].join('\n');
}

export function getTransactionStats() {
  const totalVolume = transactionStore.reduce((sum, tx) => sum + parseAmount(tx.amount), 0);
  const totalFees = transactionStore.reduce((sum, tx) => sum + parseAmount(tx.fee), 0);
  return {
    totalTransactions: transactionStore.length,
    totalVolume: totalVolume.toFixed(2),
    totalFees: totalFees.toFixed(2),
    successCount: transactionStore.filter((tx) => tx.status === 'success').length,
    pendingCount: transactionStore.filter((tx) => tx.status === 'pending').length,
    failedCount: transactionStore.filter((tx) => tx.status === 'failed').length,
  };
}

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

export function getHealthSnapshot() {
  return {
    status: 'ok',
    timestamp: Date.now(),
    services: {
      api: { status: 'ok' },
      soroban: { status: 'ok', circuitState: 'closed' },
      moonpay: { status: 'ok', circuitState: 'closed' },
      transak: { status: 'ok', circuitState: 'closed' },
      cex: { status: 'ok', circuitState: 'closed' },
    },
  };
}

export function recordAdminAction(action: string, details: Record<string, unknown>, actor = 'admin') {
  adminAuditLog.push({ ts: Date.now(), action, actor, details });
}

export function getAdminAuditLog() {
  return [...adminAuditLog];
}
