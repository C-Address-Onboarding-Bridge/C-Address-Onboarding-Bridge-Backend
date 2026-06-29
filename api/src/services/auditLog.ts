import crypto from 'crypto';

export type AuditEventType =
  | 'transaction_submission'
  | 'transaction_submission_result'
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
  const errors: AuditVerificationResult['errors'] = [];
  let previousHash = GENESIS_HASH;
  const recomputedHashes = new Map<number, string>();

  entries.forEach((entry, index) => {
    const expectedSequence = index + 1;
    if (entry.sequence !== expectedSequence) {
      errors.push({ sequence: entry.sequence, message: `expected sequence ${expectedSequence}` });
    }
    if (entry.previousHash !== previousHash) {
      errors.push({ sequence: entry.sequence, message: 'previousHash does not match prior entry hash' });
    }
    const expectedHash = sha256(entryHashMaterial({
      sequence: entry.sequence,
      id: entry.id,
      timestamp: entry.timestamp,
      type: entry.type,
      actor: entry.actor,
      payload: entry.payload,
      previousHash: entry.previousHash,
      retentionUntil: entry.retentionUntil,
    }));
    recomputedHashes.set(entry.sequence, expectedHash);
    if (entry.hash !== expectedHash) {
      errors.push({ sequence: entry.sequence, message: 'entry hash mismatch' });
    }
    previousHash = entry.hash;
  });

  for (const checkpoint of checkpoints) {
    const entry = entries[checkpoint.sequence - 1];
    if (!entry) {
      errors.push({ sequence: checkpoint.sequence, message: 'checkpoint references missing entry' });
      continue;
    }
    const recomputedHash = recomputedHashes.get(checkpoint.sequence);
    if (entry.hash !== checkpoint.hash || recomputedHash !== checkpoint.hash) {
      errors.push({ sequence: checkpoint.sequence, message: 'checkpoint hash does not match recomputed entry hash' });
    }
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

  constructor(options: { checkpointInterval?: number; checkpointUrl?: string } = {}) {
    this.checkpointInterval = options.checkpointInterval ?? Number.parseInt(process.env.AUDIT_CHECKPOINT_INTERVAL || String(DEFAULT_CHECKPOINT_INTERVAL), 10);
    this.checkpointUrl = options.checkpointUrl ?? process.env.AUDIT_CHECKPOINT_URL;
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
    this.entries = [];
    this.checkpoints = [];
  }

  tamperForTest(sequence: number, payload: Record<string, unknown>): void {
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
    return cloneCheckpoint(checkpoint);
  }
}

export const integrityAuditLog = new IntegrityAuditLogService();
