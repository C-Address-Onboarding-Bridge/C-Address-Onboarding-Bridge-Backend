import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import type { Migration } from '../runner';

// ---------------------------------------------------------------------------
// Mock ../services/db so MigrationRunner never touches a real database.
// We expose a `mockClient` object whose methods can be swapped per test.
// ---------------------------------------------------------------------------

/** Fluent builder for a mocked PoolClient. */
function makeMockClient(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  const query = vi.fn();
  const release = vi.fn();
  return { query, release, ...overrides } as unknown as PoolClient & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}

// We need the mock to be set up before importing the module under test.
let mockClient = makeMockClient();

vi.mock('../../services/db', () => ({
  getPool: vi.fn(() => ({
    connect: vi.fn(() => Promise.resolve(mockClient)),
  })),
}));

// Import AFTER the mock is registered.
import { MigrationRunner } from '../runner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a migration whose up/down functions track whether they were called. */
function makeMigration(
  version: string,
  name: string,
): Migration & { upCalled: boolean; downCalled: boolean } {
  const m: Migration & { upCalled: boolean; downCalled: boolean } = {
    version,
    name,
    upCalled: false,
    downCalled: false,
    async up() {
      m.upCalled = true;
    },
    async down() {
      m.downCalled = true;
    },
  };
  return m;
}

/**
 * Wire up a client whose query() responses follow a standard migrate() flow:
 *
 *  1. BEGIN
 *  2. SELECT pg_try_advisory_xact_lock  →  returns `locked`
 *  3. CREATE TABLE IF NOT EXISTS        →  no-op
 *  4. SELECT version FROM schema_migrations  →  returns `appliedVersions`
 *  ... (INSERT for each applied migration)
 *  N. COMMIT / ROLLBACK
 */
function setupMigrateClient(
  client: ReturnType<typeof makeMockClient>,
  {
    locked = true,
    appliedVersions = [] as string[],
  } = {},
) {
  let callCount = 0;
  client.query.mockImplementation((sql: string) => {
    callCount++;

    if (typeof sql === 'string' && sql.trim().toUpperCase() === 'BEGIN') {
      return Promise.resolve({ rows: [] });
    }
    if (typeof sql === 'string' && sql.includes('pg_try_advisory_xact_lock')) {
      return Promise.resolve({ rows: [{ pg_try_advisory_xact_lock: locked }] });
    }
    if (typeof sql === 'string' && sql.includes('CREATE TABLE IF NOT EXISTS')) {
      return Promise.resolve({ rows: [] });
    }
    if (typeof sql === 'string' && sql.includes('SELECT version FROM schema_migrations')) {
      return Promise.resolve({ rows: appliedVersions.map((v) => ({ version: v })) });
    }
    if (
      typeof sql === 'string' &&
      (sql.trim().toUpperCase() === 'COMMIT' || sql.trim().toUpperCase() === 'ROLLBACK')
    ) {
      return Promise.resolve({ rows: [] });
    }
    // INSERT INTO schema_migrations … or anything else
    return Promise.resolve({ rows: [] });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MigrationRunner', () => {
  beforeEach(() => {
    // Fresh mock client for each test so call history does not bleed across.
    mockClient = makeMockClient();
  });

  // -------------------------------------------------------------------------
  describe('migrate() — no-op when all versions are already applied', () => {
    it('skips every migration and returns empty applied array', async () => {
      const runner = new MigrationRunner();
      const m001 = makeMigration('001', 'create_users');
      const m002 = makeMigration('002', 'add_index');
      runner.register(m001).register(m002);

      // Simulate DB already having both versions applied.
      setupMigrateClient(mockClient, { locked: true, appliedVersions: ['001', '002'] });

      const { applied, skipped } = await runner.migrate();

      expect(applied).toHaveLength(0);
      expect(skipped).toEqual(['001', '002']);
      expect(m001.upCalled).toBe(false);
      expect(m002.upCalled).toBe(false);
    });

    it('commits the transaction even when all migrations are skipped', async () => {
      const runner = new MigrationRunner();
      runner.register(makeMigration('001', 'setup'));

      setupMigrateClient(mockClient, { locked: true, appliedVersions: ['001'] });

      await runner.migrate();

      // COMMIT must appear in the query calls.
      const calls: string[] = mockClient.query.mock.calls.map((c: unknown[]) =>
        String(c[0]).trim().toUpperCase(),
      );
      expect(calls).toContain('COMMIT');
    });
  });

  // -------------------------------------------------------------------------
  describe('migrate() — advisory lock behaviour', () => {
    it('acquires advisory lock and applies pending migration when lock succeeds', async () => {
      const runner = new MigrationRunner();
      const m001 = makeMigration('001', 'create_users');
      runner.register(m001);

      setupMigrateClient(mockClient, { locked: true, appliedVersions: [] });

      const { applied } = await runner.migrate();

      expect(applied).toContain('001');
      expect(m001.upCalled).toBe(true);

      // Verify pg_try_advisory_xact_lock was called with the expected key.
      const advisoryCall = mockClient.query.mock.calls.find((c: unknown[]) =>
        String(c[0]).includes('pg_try_advisory_xact_lock'),
      );
      expect(advisoryCall).toBeDefined();
      expect(advisoryCall![1]).toEqual([7483920]);
    });

    it('throws when advisory lock cannot be acquired', async () => {
      const runner = new MigrationRunner();
      runner.register(makeMigration('001', 'create_users'));

      // pg_try_advisory_xact_lock returns false → another migration is running.
      setupMigrateClient(mockClient, { locked: false, appliedVersions: [] });

      await expect(runner.migrate()).rejects.toThrow(
        'another migration is in progress — please try again later',
      );
    });

    it('rolls back the transaction when lock cannot be acquired', async () => {
      const runner = new MigrationRunner();
      runner.register(makeMigration('001', 'create_users'));

      setupMigrateClient(mockClient, { locked: false });

      await expect(runner.migrate()).rejects.toThrow();

      const calls: string[] = mockClient.query.mock.calls.map((c: unknown[]) =>
        String(c[0]).trim().toUpperCase(),
      );
      expect(calls).toContain('ROLLBACK');
    });

    it('releases the client connection whether the lock succeeds or fails', async () => {
      const runner = new MigrationRunner();
      runner.register(makeMigration('001', 'create_users'));

      setupMigrateClient(mockClient, { locked: false });

      await expect(runner.migrate()).rejects.toThrow();

      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('migrate() — error handling', () => {
    it('rolls back and rethrows when migration.up() throws', async () => {
      const runner = new MigrationRunner();
      const failingMigration: Migration = {
        version: '001',
        name: 'will_fail',
        async up() {
          throw new Error('migration failed');
        },
        async down() {},
      };
      runner.register(failingMigration);

      setupMigrateClient(mockClient, { locked: true, appliedVersions: [] });

      await expect(runner.migrate()).rejects.toThrow('migration failed');

      const calls: string[] = mockClient.query.mock.calls.map((c: unknown[]) =>
        String(c[0]).trim().toUpperCase(),
      );
      expect(calls).toContain('ROLLBACK');
    });

    it('throws when DATABASE_URL is not configured (pool returns null)', async () => {
      // Temporarily override getPool to return null.
      const { getPool } = await import('../../services/db');
      (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

      const runner = new MigrationRunner();
      runner.register(makeMigration('001', 'create_users'));

      await expect(runner.migrate()).rejects.toThrow('DATABASE_URL is not configured');
    });
  });

  // -------------------------------------------------------------------------
  describe('register()', () => {
    it('sorts migrations by version when registered out of order', () => {
      const runner = new MigrationRunner();
      runner.register(makeMigration('003', 'c')).register(makeMigration('001', 'a')).register(makeMigration('002', 'b'));

      // Access private field via cast for white-box verification.
      const migrations = (runner as unknown as { migrations: Migration[] }).migrations;
      expect(migrations.map((m) => m.version)).toEqual(['001', '002', '003']);
    });
  });
});
