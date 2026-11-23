import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrityAuditLogService } from '../services/auditLog';
import { getPool, closePool } from '../services/db';

const DB_AVAILABLE = !!process.env.DATABASE_URL;

// #1053 — two IntegrityAuditLogService instances sharing one DB.
// Each has its own in-memory mirror, so this simulates "API replica + BullMQ
// worker" or "two API replicas". Both must produce one contiguous, verifiable
// chain because sequencing is now DB-authoritative under pg_advisory_xact_lock.
describe.skipIf(!DB_AVAILABLE)('IntegrityAuditLogService — cross-process integration', () => {
  const RUN_ID = `it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    const pool = getPool();
    if (!pool) throw new Error('expected pool with DATABASE_URL set');
    // Isolate: only entries tagged with this RUN_ID will be asserted on.
    // We use the actor field to tag entries so we don't disturb other rows.
  });

  afterAll(async () => {
    const pool = getPool();
    if (pool) {
      await pool.query('DELETE FROM audit_log_checkpoints WHERE sequence IN (SELECT sequence FROM audit_log_entries WHERE actor LIKE $1)', [`${RUN_ID}%`]);
      await pool.query('DELETE FROM audit_log_entries WHERE actor LIKE $1', [`${RUN_ID}%`]);
    }
    await closePool();
  });

  it('interleaves two instances into one contiguous, verifiable chain', async () => {
    const serviceA = new IntegrityAuditLogService({ checkpointInterval: 0 });
    const serviceB = new IntegrityAuditLogService({ checkpointInterval: 0 });

    const actorA = `${RUN_ID}:A`;
    const actorB = `${RUN_ID}:B`;

    const N = 10;
    for (let i = 0; i < N; i++) {
      await serviceA.append('admin_operation', { i, side: 'A' }, actorA);
      await serviceB.append('admin_operation', { i, side: 'B' }, actorB);
    }

    // Read the entries this run created, from the DB.
    const pool = getPool()!;
    const result = await pool.query(
      'SELECT sequence, hash, previous_hash FROM audit_log_entries WHERE actor LIKE $1 ORDER BY sequence ASC',
      [`${RUN_ID}%`],
    );
    const rows = result.rows;

    expect(rows.length).toBe(2 * N);

    // Contiguous sequences from the minimum.
    const seqs = rows.map((r) => Number(r.sequence));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }

    // Each row's previous_hash equals the prior row's hash (within this run).
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].previous_hash).toBe(rows[i - 1].hash);
    }

    // Cross-read: service B sees entries appended by service A via the DB path.
    const seenByB = await serviceB.listEntriesFromDb({ limit: 100000 });
    const actorASeen = seenByB.filter((e) => e.actor === actorA);
    const actorBSeen = seenByB.filter((e) => e.actor === actorB);
    expect(actorASeen.length).toBe(N);
    expect(actorBSeen.length).toBe(N);
    // Order interleaved A,B,A,B,...
    const ordered = seenByB.filter((e) => e.actor === actorA || e.actor === actorB);
    for (let i = 0; i < ordered.length; i++) {
      expect(ordered[i].actor).toBe(i % 2 === 0 ? actorA : actorB);
    }

    // Full chain verify from DB (includes everything in the table, so it might
    // fail if other rows are corrupt — that's a real signal, not a flake).
    const verification = await serviceA.verifyFromDb();
    expect(verification.valid).toBe(true);
    expect(verification.errors).toEqual([]);
  }, 30000);
});
