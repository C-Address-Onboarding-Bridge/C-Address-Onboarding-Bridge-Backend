import crypto from 'crypto';
import { getPool } from './db';

export type AuditEventType =
  | 'transaction_submission'
  | 'transaction_submission_result'
  // Emitted by src/routes/funding.ts. The call sites were added without the
  // union being widened, so every one of them failed to typecheck.
  | 'batch_transaction_submission_result'
  | 'timelocked_transaction_submission_result'
  | 'timelocked_claim_result'
  | 'fee_withdrawal'
  | 'admin_operation'
  | 'webhook_delivery';

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

  // Build a map of checkpoints by sequence for O(1) lookup
  const checkpointMap = new Map<number, AuditCheckpoint>();
  for (const cp of checkpoints) {
    checkpointMap.set(cp.sequence, cp);
  }

  let expectedPreviousHash = GENESIS_HASH;

  for (const entry of entries) {
    // 1. Verify the previousHash links correctly to the prior entry
    if (entry.previousHash !== expectedPreviousHash) {
      errors.push({
        sequence: entry.sequence,
        message: 'broken chain link',
      });
    }

    // 2. Recompute the entry's hash and compare
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
      errors.push({
        sequence: entry.sequence,
        message: 'entry hash mismatch',
      });
    }

    // 3. Verify checkpoint for this sequence, if one exists
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

export class IntegrityAuditLogService {
  private entries: AuditLogEntry[] = [];
  private checkpoints: AuditCheckpoint[] = [];
  private readonly checkpointInterval: number;
  private readonly checkpointUrl?: string;
  private initialized = false;

  constructor(options: { checkpointInterval?: number; checkpointUrl?: string } = {}) {
    this.checkpointInterval = options.checkpointInterval ?? Number.parseInt(process.env.AUDIT_CHECKPOINT_INTERVAL || String(DEFAULT_CHECKPOINT_INTERVAL), 10);
    this.checkpointUrl = options.checkpointUrl ?? process.env.AUDIT_CHECKPOINT_URL;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.loadFromDatabase();
    this.initialized = true;
  }

  private async loadFromDatabase(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const entriesResult = await pool.query(
        'SELECT sequence, id, timestamp, type, actor, payload, previous_hash, hash, retention_until FROM audit_log_entries ORDER BY sequence ASC',
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
      console.warn('Failed to load audit log from database:', err);
    }
  }

  private async saveEntryToDatabase(entry: AuditLogEntry): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
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
      console.warn('Failed to save audit entry to database:', err);
    }
  }

  private async saveCheckpointToDatabase(checkpoint: AuditCheckpoint): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO audit_log_checkpoints
         (sequence, hash, published_at, publisher, publication_ref)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          checkpoint.sequence,
          checkpoint.hash,
          checkpoint.timestamp,
          checkpoint.publisher,
          checkpoint.publicationRef,
        ],
      );
    } catch (err) {
      console.warn('Failed to save checkpoint to database:', err);
    }
  }

  append(type: AuditEventType, payload: Record<string, unknown>, actor = 'system'): AuditLogEntry {
    const previousHash = this.entries.at(-1)?.hash ?? GENESIS_HASH;
    const entryWithoutHash: Omit<AuditLogEntry, 'hash'> = {
      sequence: this.entries.length + 1,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type,
      actor,
      payload,
      previousHash,
      retentionUntil: Date.now() + SEVEN_YEARS_MS,
    };
    const entry: AuditLogEntry = {
      ...entryWithoutHash,
      hash: sha256(entryHashMaterial(entryWithoutHash)),
    };

    this.entries.push(entry);
    void this.saveEntryToDatabase(entry);

    if (this.checkpointInterval > 0 && entry.sequence % this.checkpointInterval === 0) {
      void this.publishCheckpoint(entry);
    }

    return cloneEntry(entry);
  }

  publishCheckpointForLatest(): AuditCheckpoint | null {
    const latest = this.entries.at(-1);
    if (!latest) return null;
    return this.createCheckpoint(latest, 'local', `local:${latest.sequence}:${latest.hash}`);
  }

  listEntries(params: { type?: AuditEventType; limit?: number; cursor?: number } = {}): AuditLogEntry[] {
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
      });
      this.createCheckpoint(entry, 'trusted-timestamp', `${this.checkpointUrl}:${response.status}:${entry.sequence}`);
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
