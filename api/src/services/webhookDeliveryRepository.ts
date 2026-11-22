import { Pool } from 'pg';

export interface WebhookRegistration {
  id: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  createdAt: string;
}

export interface WebhookDeliveryLogEntry {
  id: string;
  registrationId: string;
  event: string;
  status: 'success' | 'failure';
  attempts: number;
  responseStatus?: number;
  error?: string;
  createdAt: string;
}

export interface WebhookDlqEntry {
  id: string;
  registrationId: string;
  event: string;
  payload: unknown;
  attempts: number;
  lastError?: string;
  createdAt: string;
}

/**
 * Postgres-backed persistence for webhook registrations, DLQ entries and the
 * delivery log. Replaces the previous in-memory maps/arrays so state survives
 * restarts and is shared across API instances.
 */
export class WebhookDeliveryRepository {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_registrations (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        events TEXT[] NOT NULL DEFAULT '{}',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_dlq (
        id TEXT PRIMARY KEY,
        registration_id TEXT NOT NULL,
        event TEXT NOT NULL,
        payload JSONB NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_delivery_log (
        id TEXT PRIMARY KEY,
        registration_id TEXT NOT NULL,
        event TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        response_status INTEGER,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS webhook_delivery_log_created_at_idx ON webhook_delivery_log (created_at);`,
    );
  }

  // --- Registrations -------------------------------------------------------

  async listRegistrations(): Promise<WebhookRegistration[]> {
    const { rows } = await this.pool.query(
      `SELECT id, url, secret, events, active, created_at FROM webhook_registrations ORDER BY created_at ASC`,
    );
    return rows.map(this.mapRegistration);
  }

  async getRegistration(id: string): Promise<WebhookRegistration | undefined> {
    const { rows } = await this.pool.query(
      `SELECT id, url, secret, events, active, created_at FROM webhook_registrations WHERE id = $1`,
      [id],
    );
    return rows[0] ? this.mapRegistration(rows[0]) : undefined;
  }

  async saveRegistration(reg: WebhookRegistration): Promise<void> {
    await this.pool.query(
      `INSERT INTO webhook_registrations (id, url, secret, events, active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, secret = EXCLUDED.secret,
         events = EXCLUDED.events, active = EXCLUDED.active`,
      [reg.id, reg.url, reg.secret, reg.events, reg.active, reg.createdAt],
    );
  }

  async deleteRegistration(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM webhook_registrations WHERE id = $1`, [id]);
  }

  // --- DLQ -----------------------------------------------------------------

  async listDlq(): Promise<WebhookDlqEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT id, registration_id, event, payload, attempts, last_error, created_at FROM webhook_dlq ORDER BY created_at ASC`,
    );
    return rows.map(this.mapDlq);
  }

  async addDlq(entry: WebhookDlqEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO webhook_dlq (id, registration_id, event, payload, attempts, last_error, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET attempts = EXCLUDED.attempts, last_error = EXCLUDED.last_error`,
      [
        entry.id,
        entry.registrationId,
        entry.event,
        JSON.stringify(entry.payload),
        entry.attempts,
        entry.lastError ?? null,
        entry.createdAt,
      ],
    );
  }

  async removeDlq(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM webhook_dlq WHERE id = $1`, [id]);
  }

  // --- Delivery log --------------------------------------------------------

  async appendDeliveryLog(entry: WebhookDeliveryLogEntry, retentionLimit = 1000): Promise<void> {
    await this.pool.query(
      `INSERT INTO webhook_delivery_log (id, registration_id, event, status, attempts, response_status, error, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.id,
        entry.registrationId,
        entry.event,
        entry.status,
        entry.attempts,
        entry.responseStatus ?? null,
        entry.error ?? null,
        entry.createdAt,
      ],
    );
    // Retention: keep only the most recent `retentionLimit` entries so the log
    // does not grow without bound.
    await this.pool.query(
      `DELETE FROM webhook_delivery_log
       WHERE id IN (
         SELECT id FROM webhook_delivery_log
         ORDER BY created_at DESC
         OFFSET $1
       )`,
      [retentionLimit],
    );
  }

  async listDeliveryLog(limit = 100): Promise<WebhookDeliveryLogEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT id, registration_id, event, status, attempts, response_status, error, created_at
       FROM webhook_delivery_log ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(this.mapDeliveryLog);
  }

  private mapRegistration(row: any): WebhookRegistration {
    return {
      id: row.id,
      url: row.url,
      secret: row.secret,
      events: row.events ?? [],
      active: row.active,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private mapDlq(row: any): WebhookDlqEntry {
    return {
      id: row.id,
      registrationId: row.registration_id,
      event: row.event,
      payload: row.payload,
      attempts: row.attempts,
      lastError: row.last_error ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private mapDeliveryLog(row: any): WebhookDeliveryLogEntry {
    return {
      id: row.id,
      registrationId: row.registration_id,
      event: row.event,
      status: row.status,
      attempts: row.attempts,
      responseStatus: row.response_status ?? undefined,
      error: row.error ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }
}
