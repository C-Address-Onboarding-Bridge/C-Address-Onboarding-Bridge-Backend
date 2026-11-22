import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the SQL each migration sends instead of touching a database.
const runDDL = vi.fn<(sql: string) => Promise<void>>(() => Promise.resolve());
vi.mock('../runner', () => ({ runDDL: (sql: string) => runDDL(sql) }));

import { migration007, REDUNDANT_INDEXES } from '../007_drop_redundant_indexes';
import { migration005 } from '../005_query_optimization_indexes';

const lastSql = () => runDDL.mock.calls.at(-1)![0];

/** Indexes that must survive 007: one per distinct column prefix (#1071). */
const KEPT_INDEXES = [
  'idx_tx_source_time',
  'idx_tx_status_time',
  'idx_tx_source_target',
  'idx_audit_log_event_type_created',
  'idx_audit_log_actor_created',
];

describe('migration 007 — drop redundant indexes (#1071)', () => {
  beforeEach(() => runDDL.mockClear());

  it('is ordered after 006', () => {
    expect(migration007.version).toBe('007');
    expect(migration007.version > '006').toBe(true);
  });

  it('drops every redundant index idempotently', async () => {
    await migration007.up();
    const sql = lastSql();
    for (const name of REDUNDANT_INDEXES) {
      expect(sql).toContain(`DROP INDEX IF EXISTS ${name};`);
    }
    expect(sql.match(/DROP INDEX/g)).toHaveLength(REDUNDANT_INDEXES.length);
  });

  it('keeps one index per column prefix and the tx_hash unique constraint', async () => {
    await migration007.up();
    const sql = lastSql();
    for (const name of KEPT_INDEXES) {
      expect(sql).not.toContain(name);
    }
    expect(sql).not.toMatch(/DROP CONSTRAINT|ALTER TABLE/i);
  });

  it('down() recreates exactly the dropped indexes', async () => {
    await migration007.down();
    const sql = lastSql();
    const created = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(created.sort()).toEqual([...REDUNDANT_INDEXES].sort());
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_hash_covering[\s\S]*INCLUDE/);
  });
});

describe('migration 005 — pg_stat_statements guard (#1071)', () => {
  beforeEach(() => runDDL.mockClear());

  it('creates the extension only inside a guarded DO block', async () => {
    await migration005.up();
    const sql = lastSql();
    const doBlock = sql.slice(sql.indexOf('DO $$'), sql.indexOf('END\n      $$;'));
    expect(doBlock).toContain('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    expect(doBlock).toMatch(/EXCEPTION\s+WHEN insufficient_privilege/);
    expect(sql.match(/CREATE EXTENSION/g)).toHaveLength(1);
  });

  it('still creates the composite indexes after the guard', async () => {
    await migration005.up();
    const sql = lastSql();
    expect(sql.indexOf('idx_tx_source_time')).toBeGreaterThan(sql.indexOf('DO $$'));
  });
});
