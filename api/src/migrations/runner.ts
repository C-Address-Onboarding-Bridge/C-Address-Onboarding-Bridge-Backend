import type { PoolClient } from 'pg';
import { getPool } from '../services/db';

/** Executes raw SQL against the configured Postgres pool inside a single transaction. */
export async function runDDL(sql: string): Promise<void> {
  const pool = getPool();
  if (!pool) {
    throw new Error('cannot run migration: DATABASE_URL is not configured');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface Migration {
  version: string;
  name: string;
  up: () => Promise<void>;
  down: () => Promise<void>;
}

/** Fixed advisory lock key used to serialise concurrent migrate() calls. */
const ADVISORY_LOCK_KEY = 7483920;

export class MigrationRunner {
  private migrations: Migration[] = [];

  /**
   * @deprecated The stateFile parameter is ignored. All migration state is
   * persisted in the `schema_migrations` Postgres table. The parameter is
   * kept for backward-compatibility only.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_stateFile?: string) {
    // stateFile intentionally unused — state is stored in the database.
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getClient(): Promise<PoolClient> {
    const pool = getPool();
    if (!pool) {
      throw new Error('cannot run migration: DATABASE_URL is not configured');
    }
    return pool.connect();
  }

  /**
   * Creates the schema_migrations tracking table if it does not already exist.
   * Must be called inside an active transaction.
   */
  private async ensureTable(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT    PRIMARY KEY,
        name       TEXT    NOT NULL,
        applied_at BIGINT  NOT NULL
      )
    `);
  }

  /**
   * Loads applied migration records from the database.
   * Opens its own short-lived connection so it can be used outside of the
   * advisory-locked migrate() transaction.
   */
  private async loadApplied(): Promise<Array<{ version: string; name: string; appliedAt: number }>> {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      await this.ensureTable(client);
      const result = await client.query<{ version: string; name: string; applied_at: string }>(
        'SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC',
      );
      await client.query('COMMIT');
      return result.rows.map((r) => ({
        version: r.version,
        name: r.name,
        appliedAt: Number(r.applied_at),
      }));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  register(migration: Migration): this {
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.version.localeCompare(b.version));
    return this;
  }

  /**
   * Runs all pending migrations in version order.
   *
   * Takes a Postgres advisory transaction lock so that two replicas starting
   * simultaneously cannot apply the same migration concurrently.
   */
  async migrate(): Promise<{ applied: string[]; skipped: string[] }> {
    const client = await this.getClient();
    const applied: string[] = [];
    const skipped: string[] = [];

    try {
      await client.query('BEGIN');

      // Acquire advisory lock — scoped to this transaction, released on COMMIT/ROLLBACK.
      const lockResult = await client.query<{ pg_try_advisory_xact_lock: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1)',
        [ADVISORY_LOCK_KEY],
      );
      const locked = lockResult.rows[0]?.pg_try_advisory_xact_lock;
      if (!locked) {
        await client.query('ROLLBACK');
        throw new Error('another migration is in progress — please try again later');
      }

      await this.ensureTable(client);

      // Fetch currently applied versions while holding the lock.
      const appliedResult = await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations',
      );
      const appliedSet = new Set(appliedResult.rows.map((r) => r.version));

      for (const migration of this.migrations) {
        if (appliedSet.has(migration.version)) {
          skipped.push(migration.version);
          continue;
        }

        console.log(`[migration] running ${migration.version}: ${migration.name}`);

        // Run the migration's up() inside the same connection / transaction.
        await migration.up();

        // Record the applied version atomically with the migration work.
        await client.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
          [migration.version, migration.name, Date.now()],
        );

        applied.push(migration.version);
        console.log(`[migration] applied ${migration.version}`);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { applied, skipped };
  }

  /**
   * Rolls back the last `steps` applied migrations in reverse order.
   *
   * Each rollback runs inside its own transaction so a single failure does not
   * prevent subsequent rollbacks from completing.
   */
  async rollback(steps = 1): Promise<string[]> {
    const reverted: string[] = [];
    const appliedRecords = await this.loadApplied();
    const toRollback = [...appliedRecords].reverse().slice(0, steps);

    for (const record of toRollback) {
      const migration = this.migrations.find((m) => m.version === record.version);
      if (!migration) {
        console.warn(
          `[migration] migration ${record.version} not found in registry — skipping rollback`,
        );
        continue;
      }

      const client = await this.getClient();
      try {
        await client.query('BEGIN');

        console.log(`[migration] rolling back ${migration.version}: ${migration.name}`);

        // Run the migration's down() inside the same transaction.
        await migration.down();

        // Remove the tracking record atomically with the rollback work.
        await client.query('DELETE FROM schema_migrations WHERE version = $1', [migration.version]);

        await client.query('COMMIT');
        reverted.push(migration.version);
        console.log(`[migration] rolled back ${migration.version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    return reverted;
  }

  /**
   * Returns the status of every registered migration by querying the DB.
   */
  async status(): Promise<{ version: string; name: string; status: 'applied' | 'pending' }[]> {
    const appliedRecords = await this.loadApplied();
    const appliedSet = new Set(appliedRecords.map((r) => r.version));
    return this.migrations.map((m) => ({
      version: m.version,
      name: m.name,
      status: appliedSet.has(m.version) ? 'applied' : 'pending',
    }));
  }

  /**
   * Returns the versions of all applied migrations by querying the DB.
   */
  async getAppliedVersions(): Promise<string[]> {
    const records = await this.loadApplied();
    return records.map((r) => r.version);
  }
}

export const migrationRunner = new MigrationRunner();
