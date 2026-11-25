import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { getPool } from './db';
import { logger } from '../logger';

export type AuditEventType =
  | 'transaction_submission'
  | 'transaction_submission_result'
  | 'transaction_prepared'
  | 'batch_transaction_submission_result'
  | 'timelocked_transaction_submission_result'
  | 'timelocked_claim_result'
  | 'direct_transaction_submission_result'
  | 'fee_withdrawal'
  | 'admin_operation'
  | 'webhook_delivery'
  | 'server_start';

export interface AuditLogEntry {
  sequence: number;
  id: string;
  timestamp: number;
  type: AuditEventType;
  actor: string;
  payload: Record<string, unknown>;
  previousHash: string;
  hash: string;
  retentionUntil: number;
}

export interface AuditCheckpoint {
  sequence: number;
  hash: string;
  timestamp: number;
  publisher: 'local' | 'trusted-timestamp';
  publicationRef: string;
}

export interface AuditVerificationResult {
  valid: boolean;
  entryCount: number;
  checkpointCount: number;
  errors: Array<{ sequence?: number; message: string }>;
}

const GENESIS_HASH = '0'.repeat(64);
const SEVEN_YEARS_MS = 7 * 365 * 24 * 60 * 60 * 1000;
const DEFAULT_CHECKPOINT_INTERVAL = 10;
const CHECKPOINT_REQUEST_TIMEOUT_MS = 10_000;

// #1053: stable small-int key for pg_advisory_xact_lock. Must fit in int4.
// Chosen arbitrarily; document it here so future readers don't pick the same
// key for a different subsystem.
const AUDIT_LOG_ADVISORY_LOCK_KEY = 7177321;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function entryHashMaterial(entry: Omit<AuditLogEntry, 'hash'>): string {
  return stableStringify({
    sequence: entry.sequence,
    id: entry.id,
    timestamp: entry.timestamp,
    type: entry.type,
    actor: entry.actor,
    payload: entry.payload,
    previousHash: entry.previousHash,
    retentionUntil: entry.retentionUntil,
  });
}

function cloneEntry(entry: AuditLogEntry): AuditLogEntry {
  return JSON.parse(JSON.stringify(entry)) as AuditLogEntry;
}

function cloneCheckpoint(checkpoint: AuditCheckpoint): AuditCheckpoint {
  return { ...checkpoint };
}

export function hashPayload(payload: unknown): string {
  return sha256(stableStringify(payload));
}

export function verifyAuditChain(
  entries: AuditLogEntry[],
  checkpoints: AuditCheckpoint[] = [],
): AuditVerificationResult {
  const errors: Array<{ sequence?: number; message: string }> = [];

  const checkpointMap = new Map<number, AuditCheckpoint>();
  for (const cp of checkpoints) {
    checkpointMap.set(cp.sequence, cp);
  }

  let expectedPreviousHash = GENESIS_HASH;

  for (const entry of entries) {
    if (entry.previousHash !== expectedPreviousHash) {
      errors.push({ sequence: entry.sequence, message: 'broken chain link' });
    }

    const recomputed = sha256(
      entryHashMaterial({
        sequence: entry.sequence,
        id: entry.id,
        timestamp: entry.timestamp,
        type: entry.type,
        actor: entry.actor,
        payload: entry.payload,
        previousHash: entry.previousHash,
        retentionUntil: entry.retentionUntil,
      }),
    );

    if (recomputed !== entry.hash) {
      errors.push({ sequence: entry.sequence, message: 'entry hash mismatch' });
    }

    const checkpoint = checkpointMap.get(entry.sequence);
    if (checkpoint && checkpoint.hash !== recomputed) {
      errors.push({
        sequence: entry.sequence,
        message: 'checkpoint hash does not match recomputed entry hash',
      });
    }

    expectedPreviousHash = entry.hash;
  }

  return {
    valid: errors.length === 0,
    entryCount: entries.length,
    checkpointCount: checkpoints.length,
    errors,
  };
}

interface LatestRow {
  sequence: string | number;
  hash: string;
}

export class IntegrityAuditLogService {
  private entries: AuditLogEntry[] = [];
  private checkpoints: AuditCheckpoint[] = [];
  private readonly checkpointInterval: number;
  private readonly checkpointUrl?: string;
  private readonly pendingEntryWrites = new Map<number, Promise<void>>();
  private initialized = false;

  constructor(options: { checkpointInterval?: number; checkpointUrl?: string } = {}) {
    this.checkpointInterval =
      options.checkpointInterval ??
      Number.parseInt(
        process.env.AUDIT_CHECKPOINT_INTERVAL || String(DEFAULT_CHECKPOINT_INTERVAL),
        10,
      );
    this.checkpointUrl = options.checkpointUrl ?? process.env.AUDIT_CHECKPOINT_URL;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.loadFromDatabase();
    this.initialized = true;
  }

  // ---------------------------------------------------------------------------
  // DB load / save helpers
  // ---------------------------------------------------------------------------

  private async loadFromDatabase(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const entriesResult = await pool.query(
        'SELECT sequence, id, event_type, actor, payload, previous_hash, hash, created_at, retention_until FROM audit_log_entries ORDER BY sequence ASC',
      );

      for (const row of entriesResult.rows) {
        const entry: AuditLogEntry = {
          sequence: Number(row.sequence),
          id: row.id,
          timestamp: Number(row.created_at),
          type: row.event_type as AuditEventType,
          actor: row.actor,
          payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
          previousHash: row.previous_hash,
          hash: row.hash,
          retentionUntil: Number(row.retention_until),
        };
        this.entries.push(entry);
      }

    this.entries = entriesResult.rows.map((row: any) => ({
      sequence: Number(row.sequence),
      id: row.id,
      timestamp: Number(row.created_at),
      type: row.event_type as AuditEventType,
      actor: row.actor,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      previousHash: row.previous_hash,
      hash: row.hash,
      retentionUntil: Number(row.retention_until),
    }));

    const checkpointsResult = await pool.query(
      'SELECT sequence, hash, published_at, publisher, publication_ref FROM audit_log_checkpoints ORDER BY sequence ASC',
    );

      for (const row of checkpointsResult.rows) {
        const checkpoint: AuditCheckpoint = {
          sequence: Number(row.sequence),
          hash: row.hash,
          timestamp: Number(row.published_at),
          publisher: row.publisher as 'local' | 'trusted-timestamp',
          publicationRef: row.publication_ref,
        };
        this.checkpoints.push(checkpoint);
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load audit log from database');
    }
  }

  // ---------------------------------------------------------------------------
  // Writer — DB-transactional when a pool exists; in-memory otherwise
  // ---------------------------------------------------------------------------

  async append(
    type: AuditEventType,
    payload: Record<string, unknown>,
    actor = 'system',
  ): Promise<AuditLogEntry> {
    const pool = getPool();

    if (!pool) {
      // Pure in-memory path — keeps auditLog.test.ts working unchanged.
      const entry = this.computeNextEntryFromMemory(type, payload, actor);
      this.entries.push(entry);
      // Checkpoint on interval, in-memory only.
      if (this.checkpointInterval > 0 && entry.sequence % this.checkpointInterval === 0) {
        this.createCheckpointLocal(entry);
      }
      return cloneEntry(entry);
    }

    // DB path — allocate sequence + read previous hash under advisory lock.
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOG_ADVISORY_LOCK_KEY]);

      const latest = await client.query<LatestRow>(
        'SELECT sequence, hash FROM audit_log_entries ORDER BY sequence DESC LIMIT 1',
      );
      const lastSequence = latest.rows.length > 0 ? Number(latest.rows[0].sequence) : 0;
      const previousHash = latest.rows.length > 0 ? latest.rows[0].hash : GENESIS_HASH;

      const entry = this.buildEntry(lastSequence + 1, previousHash, type, payload, actor);

      await client.query(
        `INSERT INTO audit_log_entries
         (sequence, id, event_type, actor, payload, previous_hash, hash, created_at, retention_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          entry.sequence,
          entry.id,
          entry.type,
          entry.actor,
          JSON.stringify(entry.payload),
          entry.previousHash,
          entry.hash,
          entry.timestamp,
          entry.retentionUntil,
        ],
      );
    } catch (err) {
      logger.error({ err, sequence: entry.sequence, type: entry.type }, 'Failed to save audit entry to database');
      throw err;
    }
  }

  private async saveCheckpointToDatabase(checkpoint: AuditCheckpoint): Promise<void> {
    await this.pendingEntryWrites.get(checkpoint.sequence);
    const pool = getPool();
    if (!pool) return;

      await client.query('COMMIT');

      // Mirror update happens AFTER commit, so the mirror is authoritative for
      // this process for sync readers (used by unit tests only).
      this.entries.push(entry);
      if (checkpoint) this.checkpoints.push(checkpoint);

      // If a trusted-timestamp endpoint is configured, publish outside the tx
      // and update the mirror best-effort. Failure here does NOT fail the append
      // — the entry is already committed and verifiable from the local chain.
      if (checkpoint && this.checkpointUrl) {
        void this.tryPublishTrustedTimestamp(entry, checkpoint);
      }

      return cloneEntry(entry);
    } catch (error) {
      try {
        if (client) await client.query('ROLLBACK');
      } catch {
        // best effort
      }
      auditLogInsertFailureCounter.inc();
      logger.error(
        { err: error, type, actor },
        'audit log append failed (DB insert); entry not persisted',
      );
    } catch (err) {
      logger.error({ err, sequence: checkpoint.sequence }, 'Failed to save audit checkpoint to database');
    }
  }

  /**
   * @param timestamp When the event happened, in epoch ms. Defaults to now;
   *   the async pipeline passes the time the event was triggered on the
   *   request path, so a queued entry is not stamped with whenever the worker
   *   got to it. Retention is measured from this time too.
   */
  append(
    type: AuditEventType,
    payload: Record<string, unknown>,
    actor = 'system',
    timestamp: number = Date.now(),
  ): AuditLogEntry {
    const previousHash = this.entries.at(-1)?.hash ?? GENESIS_HASH;
    return this.buildEntry(this.entries.length + 1, previousHash, type, payload, actor);
  }

  private buildEntry(
    sequence: number,
    previousHash: string,
    type: AuditEventType,
    payload: Record<string, unknown>,
    actor: string,
  ): AuditLogEntry {
    const now = Date.now();
    const entryWithoutHash: Omit<AuditLogEntry, 'hash'> = {
      sequence,
      id: crypto.randomUUID(),
      timestamp,
      type,
      actor,
      payload,
      previousHash,
      retentionUntil: timestamp + SEVEN_YEARS_MS,
    };
    return { ...entryWithoutHash, hash: sha256(entryHashMaterial(entryWithoutHash)) };
  }

  private buildCheckpoint(
    entry: AuditLogEntry,
    publisher: AuditCheckpoint['publisher'],
    publicationRef: string,
  ): AuditCheckpoint {
    return {
      sequence: entry.sequence,
      hash: entry.hash,
      timestamp: Date.now(),
      publisher,
      publicationRef,
    };
  }

  private createCheckpointLocal(entry: AuditLogEntry): AuditCheckpoint {
    const existing = this.checkpoints.find(
      (c) => c.sequence === entry.sequence && c.hash === entry.hash,
    );
    if (existing) return cloneCheckpoint(existing);
    const cp = this.buildCheckpoint(entry, 'local', `local:${entry.sequence}:${entry.hash}`);
    this.checkpoints.push(cp);
    return cloneCheckpoint(cp);
  }

  private async tryPublishTrustedTimestamp(
    entry: AuditLogEntry,
    checkpoint: AuditCheckpoint,
  ): Promise<void> {
    if (!this.checkpointUrl) return;
    try {
      const response = await fetch(this.checkpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sequence: entry.sequence,
          hash: entry.hash,
          timestamp: entry.timestamp,
        }),
      });
      const ref = `${this.checkpointUrl}:${response.status}:${entry.sequence}`;
      const idx = this.checkpoints.findIndex(
        (c) => c.sequence === checkpoint.sequence && c.hash === checkpoint.hash,
      );
      if (idx >= 0) {
        this.checkpoints[idx] = { ...this.checkpoints[idx], publisher: 'trusted-timestamp', publicationRef: ref };
      }
      const pool = getPool();
      if (pool) {
        await pool.query(
          `UPDATE audit_log_checkpoints SET publisher = $1, publication_ref = $2 WHERE sequence = $3`,
          ['trusted-timestamp', ref, checkpoint.sequence],
        );
      }
    } catch (err) {
      logger.warn({ err, sequence: entry.sequence }, 'trusted-timestamp publish failed; local checkpoint retained');
    }
  }

    this.entries.push(entry);
    const entryWrite = this.saveEntryToDatabase(entry);
    this.pendingEntryWrites.set(entry.sequence, entryWrite);
    void entryWrite.then(
      () => this.pendingEntryWrites.delete(entry.sequence),
      () => this.pendingEntryWrites.delete(entry.sequence),
    );

    if (this.checkpointInterval > 0 && entry.sequence % this.checkpointInterval === 0) {
      void entryWrite
        .then(() => this.publishCheckpoint(entry))
        .catch((err) => console.warn('Failed to publish audit checkpoint:', err));
    }
    if (params.cursor !== undefined) {
      clauses.push(`sequence > $${i++}`);
      values.push(params.cursor);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    values.push(limit);

    const result = await pool.query(
      `SELECT sequence, id, created_at, event_type, actor, payload, previous_hash, hash, retention_until
       FROM audit_log_entries
       ${where}
       ORDER BY sequence ASC
       LIMIT $${i}`,
      values,
    );
    return result.rows.map((row: any) => ({
      sequence: Number(row.sequence),
      id: row.id,
      timestamp: Number(row.created_at),
      type: row.event_type as AuditEventType,
      actor: row.actor,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      previousHash: row.previous_hash,
      hash: row.hash,
      retentionUntil: Number(row.retention_until),
    }));
  }

  async listCheckpointsFromDb(): Promise<AuditCheckpoint[]> {
    const pool = getPool();
    if (!pool) return this.listCheckpoints();
    const result = await pool.query(
      'SELECT sequence, hash, published_at, publisher, publication_ref FROM audit_log_checkpoints ORDER BY sequence ASC',
    );
    return result.rows.map((row: any) => ({
      sequence: Number(row.sequence),
      hash: row.hash,
      timestamp: Number(row.published_at),
      publisher: row.publisher as 'local' | 'trusted-timestamp',
      publicationRef: row.publication_ref,
    }));
  }

  async verifyFromDb(): Promise<AuditVerificationResult> {
    const pool = getPool();
    if (!pool) return this.verify();
    const [entries, checkpoints] = await Promise.all([
      this.listEntriesFromDb({ limit: 100000 }),
      this.listCheckpointsFromDb(),
    ]);
    return verifyAuditChain(entries, checkpoints);
  }

  async exportNdjsonFromDb(): Promise<string> {
    const entries = await this.listEntriesFromDb({ limit: 100000 });
    return entries.map((entry) => JSON.stringify(entry)).join('\n');
  }

  async exportJsonFromDb() {
    const [entries, checkpoints, verification] = await Promise.all([
      this.listEntriesFromDb({ limit: 100000 }),
      this.listCheckpointsFromDb(),
      this.verifyFromDb(),
    ]);
    return {
      format: 'c-address-bridge.audit.v1',
      exportedAt: Date.now(),
      retentionPolicy: '7 years',
      entries,
      checkpoints,
      verification,
    };
  }

  async publishCheckpointForLatestAsync(): Promise<AuditCheckpoint | null> {
    const pool = getPool();
    if (!pool) {
      const latest = this.entries.at(-1);
      if (!latest) return null;
      return this.createCheckpointLocal(latest);
    }

    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOG_ADVISORY_LOCK_KEY]);
      const result = await client.query<LatestRow>(
        'SELECT sequence, hash FROM audit_log_entries ORDER BY sequence DESC LIMIT 1',
      );
      if (result.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }
      const latest = {
        sequence: Number(result.rows[0].sequence),
        hash: result.rows[0].hash,
      };
      const publicationRef = this.checkpointUrl
        ? `${this.checkpointUrl}:pending:${latest.sequence}`
        : `local:${latest.sequence}:${latest.hash}`;
      const publisher: AuditCheckpoint['publisher'] = this.checkpointUrl ? 'trusted-timestamp' : 'local';
      const checkpoint: AuditCheckpoint = {
        sequence: latest.sequence,
        hash: latest.hash,
        timestamp: Date.now(),
        publisher,
        publicationRef,
      };
      await client.query(
        `INSERT INTO audit_log_checkpoints
         (sequence, hash, published_at, publisher, publication_ref)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (sequence) DO UPDATE SET hash = EXCLUDED.hash, published_at = EXCLUDED.published_at, publisher = EXCLUDED.publisher, publication_ref = EXCLUDED.publication_ref`,
        [
          checkpoint.sequence,
          checkpoint.hash,
          checkpoint.timestamp,
          checkpoint.publisher,
          checkpoint.publicationRef,
        ],
      );
      await client.query('COMMIT');
      // Mirror
      const idx = this.checkpoints.findIndex((c) => c.sequence === checkpoint.sequence);
      if (idx >= 0) this.checkpoints[idx] = checkpoint;
      else this.checkpoints.push(checkpoint);
      return cloneCheckpoint(checkpoint);
    } catch (error) {
      try {
        if (client) await client.query('ROLLBACK');
      } catch {
        // best effort
      }
      auditLogInsertFailureCounter.inc();
      logger.error({ err: error }, 'publishCheckpointForLatestAsync failed');
      throw error;
    } finally {
      client?.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Sync readers — unchanged behaviour, for unit tests and non-DB paths
  // ---------------------------------------------------------------------------

  listEntries(
    params: { type?: AuditEventType; limit?: number; cursor?: number } = {},
  ): AuditLogEntry[] {
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);
    return this.entries
      .filter((entry) => (params.type ? entry.type === params.type : true))
      .filter((entry) => (params.cursor ? entry.sequence > params.cursor : true))
      .slice(0, limit)
      .map(cloneEntry);
  }

  listCheckpoints(): AuditCheckpoint[] {
    return this.checkpoints.map(cloneCheckpoint);
  }

  verify(): AuditVerificationResult {
    return verifyAuditChain(this.entries, this.checkpoints);
  }

  exportNdjson(): string {
    return this.entries.map((entry) => JSON.stringify(entry)).join('\n');
  }

  exportJson() {
    return {
      format: 'c-address-bridge.audit.v1',
      exportedAt: Date.now(),
      retentionPolicy: '7 years',
      entries: this.entries.map(cloneEntry),
      checkpoints: this.checkpoints.map(cloneCheckpoint),
      verification: this.verify(),
    };
  }

  clearForTest(): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('clearForTest() is only available in test mode');
    }
    this.entries = [];
    this.checkpoints = [];
  }

  tamperForTest(sequence: number, payload: Record<string, unknown>): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('tamperForTest() is only available in test mode');
    }
    const entry = this.entries.find((item) => item.sequence === sequence);
    if (entry) entry.payload = payload;
  }

  private async publishCheckpoint(entry: AuditLogEntry): Promise<void> {
    if (!this.checkpointUrl) {
      this.createCheckpoint(entry, 'local', `local:${entry.sequence}:${entry.hash}`);
      return;
    }

    try {
      const response = await fetch(this.checkpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sequence: entry.sequence, hash: entry.hash, timestamp: entry.timestamp }),
        signal: AbortSignal.timeout(CHECKPOINT_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Timestamp service returned HTTP ${response.status}`);
      }
      const receipt = await response.text();
      if (!receipt) {
        throw new Error('Timestamp service returned an empty receipt');
      }
      this.createCheckpoint(entry, 'trusted-timestamp', receipt);
    } catch {
      this.createCheckpoint(entry, 'local', `local-fallback:${entry.sequence}:${entry.hash}`);
    }
  }

  private createCheckpoint(entry: AuditLogEntry, publisher: AuditCheckpoint['publisher'], publicationRef: string): AuditCheckpoint {
    const existing = this.checkpoints.find((checkpoint) => checkpoint.sequence === entry.sequence && checkpoint.hash === entry.hash);
    if (existing) return cloneCheckpoint(existing);

    const checkpoint: AuditCheckpoint = {
      sequence: entry.sequence,
      hash: entry.hash,
      timestamp: Date.now(),
      publisher,
      publicationRef,
    };
    this.checkpoints.push(checkpoint);
    void this.saveCheckpointToDatabase(checkpoint);
    return cloneCheckpoint(checkpoint);
  }
}

export const integrityAuditLog = new IntegrityAuditLogService();
