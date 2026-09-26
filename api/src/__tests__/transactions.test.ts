/**
 * Tests for api/src/services/transactions.ts
 *
 * These tests verify the fixes introduced in #638, #639, and #640:
 *  - #638: No seeded fixture data, DB-backed listTransactions, integer amount validation
 *  - #639: updateFeeConfig validates against CONTRACT_MAX_FEE_BPS, does NOT mutate config.soroban.feeBps
 *  - #640: withdrawAccumulatedFees creates a governance proposal instead of zeroing in-memory state
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.NODE_ENV = 'test';

// ─── Mock logger ────────────────────────────────────────────────────────────────
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ─── Mock config ────────────────────────────────────────────────────────────────
vi.mock('../config', () => ({
  config: {
    soroban: {
      feeBps: 30,
      bridgeContractId: 'CTEST_CONTRACT',
    },
    database: { url: 'postgres://test', poolMax: 5, idleTimeoutMs: 30000, connectionTimeoutMs: 5000, ssl: false },
    logLevel: 'silent',
    logging: { serviceName: 'test', version: '0.0.0', environment: 'test', sensitiveFields: [], bodyTruncateLength: 200 },
  },
}));

// ─── Mock db ────────────────────────────────────────────────────────────────────
// We control the mock at the vi.mock() level so that resetAllMocks doesn't break things.
const mockQueryFn = vi.fn();
const mockReleaseFn = vi.fn();
const mockConnectFn = vi.fn();
const mockPoolQueryFn = vi.fn();

vi.mock('../services/db', () => ({
  getPool: vi.fn(),
}));

// Import after mocks
import {
  listTransactions,
  serializeTransactionsCsv,
  getTransactionStats,
  getFeeConfig,
  updateFeeConfig,
  withdrawAccumulatedFees,
  recordAdminAction,
  getAdminAuditLog,
  CONTRACT_MAX_FEE_BPS,
} from '../services/transactions';
import { config } from '../config';
import { getPool } from '../services/db';

// ──────────────────────────────────────────────────────────────────────────────
// FIXTURE DATA — moved from service code into tests (#638 requirement)
// ──────────────────────────────────────────────────────────────────────────────

export const transactionFixtures = [
  {
    id: 'tx_1001',
    tx_hash: '0xabc1001',
    source_addr: 'GABC1001',
    target_addr: 'GXYZ1001',
    status: 'success',
    amount: '12050',
    fee: '36',
    currency: 'USDC',
    created_at: 1750416900000,
    created_at_iso: '2026-06-20T10:15:00.000Z',
  },
  {
    id: 'tx_1002',
    tx_hash: '0xabc1002',
    source_addr: 'GABC1002',
    target_addr: 'GXYZ1002',
    status: 'pending',
    amount: '8000',
    fee: '24',
    currency: 'USDC',
    created_at: 1750502700000,
    created_at_iso: '2026-06-21T09:45:00.000Z',
  },
  {
    id: 'tx_1003',
    tx_hash: '0xabc1003',
    source_addr: 'GABC1003',
    target_addr: 'GXYZ1003',
    status: 'failed',
    amount: '4500',
    fee: '14',
    currency: 'USDC',
    created_at: 1750578600000,
    created_at_iso: '2026-06-22T05:30:00.000Z',
  },
];

/** Create a mock pool that returns the given rows from client.query() */
function makePool(rows: Record<string, unknown>[]) {
  const client = {
    query: vi.fn().mockResolvedValue({ rows }),
    release: vi.fn(),
  };
  return {
    pool: {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows }),
    },
    client,
  };
}

/** Create a mock pool that captures query values */
function makeCapturingPool() {
  const captured: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn().mockImplementation(async (sql: string, values?: unknown[]) => {
      captured.push({ sql, values: values ?? [] });
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return {
    pool: {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    },
    client,
    captured,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// #638 — listTransactions
// ──────────────────────────────────────────────────────────────────────────────

describe('#638 — listTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns real DB rows — no hard-coded fixtures in the service', async () => {
    const { pool } = makePool(transactionFixtures);
    (getPool as ReturnType<typeof vi.fn>).mockReturnValue(pool);

    const result = await listTransactions();
    expect(result.data.length).toBe(transactionFixtures.length);
    expect(result.data[0].id).toBe('tx_1001');
    // tx_1004 was in the old seeded fixtures but is NOT injected by the service
    expect(result.data.find((r) => r.id === 'tx_1004')).toBeUndefined();
  });

  it('returns empty result when no DB is configured', async () => {
    (getPool as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const result = await listTransactions();
    expect(result.data).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('does NOT inject hard-coded fixtures — empty DB returns empty list', async () => {
    const { pool } = makePool([]);
    (getPool as ReturnType<typeof vi.fn>).mockReturnValue(pool);

    const result = await listTransactions();
    expect(result.data).toHaveLength(0);
  });

  it('clamps limit to DEFAULT_LIMIT (51 as fetch probe) when not provided', async () => {
    const { pool, captured } = makeCapturingPool();
    (getPool as ReturnType<typeof vi.fn>).mockReturnValue(pool);

    await listTransactions({});
    // Last two values are fetchLimit and offset
    const call = captured[0];
    const fetchLimit = call.values[call.values.length - 2] as number;
    expect(fetchLimit).toBe(51); // DEFAULT_LIMIT(50) + 1 probe
  });

  it('clamps limit above MAX_LIMIT to MAX_LIMIT+1 (probe)', async () => {
    const { pool, captured } = makeCapturingPool();
    (getPool as ReturnType<typeof vi.fn>).mockReturnValue(pool);

    await listTransactions({ limit: 9999 });
    const call = captured[0];
    const fetchLimit = call.values[call.values.length - 2] as number;
    expect(fetchLimit).toBe(201); // MAX_LIMIT(200) + 1 probe
  });

  it('clamps negative offset to 0', async () => {
    const { pool, captured } = makeCapturingPool();
    (getPool as ReturnType<typeof vi.fn>).mockReturnValue(pool);

    await listTransactions({ offset: -100 });
    const call = captured[0];
    const capturedOffset = call.values[call.values.length - 1] as number;
    expect(capturedOffset).toBe(0);
  });

  it('parses minAmount and maxAmount as integers (not parseFloat)', async () => {
    const { pool, captured } = makeCapturingPool();
    (getPool as ReturnType<typeof vi.fn>).mockReturnValue(pool);

    await listTransactions({ minAmount: '100.7', maxAmount: '9999.99' });
    const call = captured[0];
    // Integer-truncated BigInt strings are passed as NUMERIC parameters
    expect(call.values).toContain('100');
    expect(call.values).toContain('9999');
  });

  it('hasMore is true when DB returns more rows than limit', async () => {
    const manyRows = Array.from({ length: 52 }, (_, i) => ({
      id: `tx_${i}`,
      tx_hash: `hash_${i}`,
      source_addr: 'G',
      target_addr: 'C',
      status: 'success',
      amount: '1000',
      fee: '3',
      currency: 'XLM',
      created_at: Date.now() - i * 1000,
      created_at_iso: new Date(Date.now() - i * 1000).toISOString(),
    }));
    const { pool } = makePool(manyRows);
    (getPool as ReturnType<typeof vi.fn>).mockReturnValue(pool);

    const result = await listTransactions({ limit: 50 });
    expect(result.hasMore).toBe(true);
    expect(result.data.length).toBe(50);
    expect(result.nextCursor).not.toBeNull();
  });

  it('hasMore is false when DB returns fewer rows than limit', async () => {
    const { pool } = makePool(transactionFixtures.slice(0, 2));
    (getPool as ReturnType<typeof vi.fn>).mockReturnValue(pool);

    const result = await listTransactions({ limit: 50 });
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// serializeTransactionsCsv
// ──────────────────────────────────────────────────────────────────────────────

describe('serializeTransactionsCsv', () => {
  it('produces a header row and data rows', () => {
    const csv = serializeTransactionsCsv([
      {
        id: 'tx_1001',
        txHash: '0xabc1001',
        sourceAddr: 'GABC',
        targetAddr: 'GXYZ',
        status: 'success',
        amount: '12050',
        fee: '36',
        createdAt: '2026-06-20T10:15:00.000Z',
        currency: 'USDC',
      },
    ]);
    expect(csv).toContain('id,txHash,sourceAddr,targetAddr,status,amount,fee,createdAt,currency');
    expect(csv).toContain('tx_1001');
    expect(csv).toContain('GABC');
  });

  it('escapes double-quotes in field values', () => {
    const csv = serializeTransactionsCsv([
      {
        id: 'tx_1',
        txHash: 'hash',
        sourceAddr: 'addr "with" quotes',
        targetAddr: 'target',
        status: 'success',
        amount: '100',
        fee: '0',
        createdAt: '2026-01-01T00:00:00.000Z',
        currency: 'XLM',
      },
    ]);
    expect(csv).toContain('addr ""with"" quotes');
  });

  it('returns only header for empty list', () => {
    const csv = serializeTransactionsCsv([]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('id,txHash,sourceAddr,targetAddr,status,amount,fee,createdAt,currency');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #639 — updateFeeConfig
// ──────────────────────────────────────────────────────────────────────────────

describe('#639 — updateFeeConfig', () => {
  it('CONTRACT_MAX_FEE_BPS is 1000', () => {
    expect(CONTRACT_MAX_FEE_BPS).toBe(1000);
  });

  it('accepts feeBps within [0, CONTRACT_MAX_FEE_BPS]', () => {
    expect(() => updateFeeConfig(0, 60000)).not.toThrow();
    expect(() => updateFeeConfig(500, 0)).not.toThrow();
    expect(() => updateFeeConfig(CONTRACT_MAX_FEE_BPS, 0)).not.toThrow();
  });

  it('rejects feeBps above CONTRACT_MAX_FEE_BPS (1000) — was previously allowed up to 10000', () => {
    expect(() => updateFeeConfig(1001, 60000)).toThrow(RangeError);
    expect(() => updateFeeConfig(10000, 60000)).toThrow(RangeError);
  });

  it('rejects negative feeBps', () => {
    expect(() => updateFeeConfig(-1, 60000)).toThrow(RangeError);
  });

  it('rejects negative timelockMs', () => {
    expect(() => updateFeeConfig(30, -1)).toThrow(RangeError);
  });

  it('rejects NaN timelockMs', () => {
    expect(() => updateFeeConfig(30, NaN)).toThrow(RangeError);
  });

  it('does NOT mutate config.soroban.feeBps (#639 — immediate config mutation was the bug)', () => {
    const originalFeeBps = config.soroban.feeBps;
    updateFeeConfig(100, 60000);
    // The live in-process config must not change — only a governance proposal is tracked
    expect(config.soroban.feeBps).toBe(originalFeeBps);
  });

  it('returns the pending proposal details', () => {
    const before = Date.now();
    const result = updateFeeConfig(50, 120000);
    expect(result.pendingFeeBps).toBe(50);
    expect(result.timelockUntil).toBeGreaterThanOrEqual(before + 120000);
  });

  it('getFeeConfig reflects the pending proposal without changing feeBps', () => {
    const stateBefore = getFeeConfig();
    updateFeeConfig(200, 0);
    const stateAfter = getFeeConfig();
    expect(stateAfter.pendingFeeBps).toBe(200);
    // feeBps field (the live contract fee at init) stays unchanged
    expect(stateAfter.feeBps).toBe(stateBefore.feeBps);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #640 — withdrawAccumulatedFees
// ──────────────────────────────────────────────────────────────────────────────

describe('#640 — withdrawAccumulatedFees', () => {
  it('returns a governance proposal, not a completed withdrawal', async () => {
    const result = await withdrawAccumulatedFees();
    expect(result.status).toBe('proposal_created');
    expect(result.proposalId).toMatch(/^withdraw_proposal_/);
  });

  it('does NOT claim funds have moved (old bug: status was "completed")', async () => {
    const result = await withdrawAccumulatedFees();
    expect(result.status).not.toBe('completed');
    // Old code returned { withdrawn: '1.20', status: 'completed' } — must be gone
    expect((result as Record<string, unknown>)['withdrawn']).toBeUndefined();
  });

  it('accepts optional recipient and token address', async () => {
    const result = await withdrawAccumulatedFees('GABCDEF', 'CTOKEN123');
    expect(result.recipient).toBe('GABCDEF');
    expect(result.token).toBe('CTOKEN123');
  });

  it('multiple calls generate unique proposal IDs', async () => {
    const r1 = await withdrawAccumulatedFees();
    await new Promise((r) => setTimeout(r, 2));
    const r2 = await withdrawAccumulatedFees();
    expect(r1.proposalId).not.toBe(r2.proposalId);
  });

  it('includes a note instructing on-chain execution', async () => {
    const result = await withdrawAccumulatedFees();
    expect(result.note).toContain('withdraw_fees');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getTransactionStats
// ──────────────────────────────────────────────────────────────────────────────

describe('getTransactionStats', () => {
  it('returns zero counts when DB is not configured', async () => {
    (getPool as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const stats = await getTransactionStats();
    expect(stats.total).toBe(0);
    expect(stats.byStatus.pending).toBe(0);
    expect(stats.byStatus.success).toBe(0);
    expect(stats.byStatus.failed).toBe(0);
  });

  it('aggregates status counts from DB', async () => {
    const statsRows = [
      { status: 'success', count: '1' },
      { status: 'pending', count: '1' },
      { status: 'failed', count: '1' },
    ];
    const { pool } = makePool(statsRows);
    (getPool as ReturnType<typeof vi.fn>).mockReturnValue(pool);

    const stats = await getTransactionStats();
    expect(stats.total).toBe(3);
    expect(stats.byStatus.success).toBe(1);
    expect(stats.byStatus.pending).toBe(1);
    expect(stats.byStatus.failed).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// recordAdminAction / getAdminAuditLog
// ──────────────────────────────────────────────────────────────────────────────

describe('recordAdminAction / getAdminAuditLog', () => {
  it('records an action and returns it via getAdminAuditLog', () => {
    const uniqueAction = 'test_action_' + Date.now() + '_' + Math.random();
    recordAdminAction(uniqueAction, { key: 'value' }, 'test-actor');
    const log = getAdminAuditLog();
    const found = log.find((e) => e.action === uniqueAction);
    expect(found).toBeDefined();
    expect(found?.actor).toBe('test-actor');
    expect(found?.details).toMatchObject({ key: 'value' });
  });
});

// unused mock refs to satisfy import
void mockQueryFn;
void mockReleaseFn;
void mockConnectFn;
void mockPoolQueryFn;
