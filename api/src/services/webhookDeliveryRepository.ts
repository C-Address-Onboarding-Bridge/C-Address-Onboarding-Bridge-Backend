import type { Pool } from 'pg';
import crypto from 'crypto';
import type { DLQEntry, DeliveryAttempt, WebhookRegistration, WebhookStore } from './webhookDelivery';

interface RegistrationRow {
  id: string;
  api_key_id: string | null;
  url: string;
  secret: string | null;
  events: string | string[] | null;
  created_at: number | string;
}

interface DeliveryAttemptRow {
  id: string;
  registration_id: string;
  webhook_url: string;
  event: string;
  status_code: number | null;
  error: string | null;
  delivered_at: number | string;
  attempt_number: number;
}

interface DLQRow {
  id: string;
  registration_id: string;
  event: string;
  payload: unknown;
  attempts: unknown;
  failed_at: number | string;
  registration_url: string;
  registration_secret: string | null;
  registration_api_key_id: string | null;
  registration_events: string | string[] | null;
  registration_created_at: number | string;
}

/**
 * Postgres-backed persistence for webhook registrations, DLQ entries and the
 * delivery log. Replaces the previous in-memory maps/arrays so state survives
 * restarts and is shared across API instances.
 */
export class WebhookDeliveryRepository {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    // Schema is created by the migration runner (migration 001).
    // This stub is kept so callers do not need to change.
  }
  return [];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export class WebhookDeliveryRepository implements WebhookStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async saveRegistration(registration: WebhookRegistration): Promise<void> {
    const secretHash = crypto.createHash('sha256').update(registration.secret).digest('hex');
    await this.pool.query(
      `INSERT INTO webhook_registrations
         (id, api_key, secret_hash, api_key_id, url, secret, events, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         api_key = EXCLUDED.api_key,
         secret_hash = EXCLUDED.secret_hash,
         api_key_id = EXCLUDED.api_key_id,
         url = EXCLUDED.url,
         secret = EXCLUDED.secret,
         events = EXCLUDED.events`,
      [
        registration.id,
        registration.apiKeyId,
        secretHash,
        registration.apiKeyId,
        registration.url,
        registration.secret,
        JSON.stringify(registration.events),
        registration.createdAt,
      ],
    );
  }

  async deleteRegistration(id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM webhook_delivery_log WHERE registration_id = $1', [id]);
      await client.query('DELETE FROM webhook_dlq WHERE registration_id = $1', [id]);
      const result = await client.query('DELETE FROM webhook_registrations WHERE id = $1 RETURNING id', [id]);
      await client.query('COMMIT');
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getRegistration(id: string): Promise<WebhookRegistration | undefined> {
    const { rows } = await this.pool.query<RegistrationRow>(
      `SELECT id, api_key_id, url, secret, events, created_at
       FROM webhook_registrations WHERE id = $1`,
      [id],
    );
    return rows[0] ? this.mapRegistration(rows[0]) : undefined;
  }

  async listRegistrations(): Promise<WebhookRegistration[]> {
    const { rows } = await this.pool.query<RegistrationRow>(
      `SELECT id, api_key_id, url, secret, events, created_at
       FROM webhook_registrations ORDER BY created_at ASC`,
    );
    return rows.map((row) => this.mapRegistration(row));
  }

  async getRegistrationsByApiKeyId(apiKeyId: string): Promise<WebhookRegistration[]> {
    const { rows } = await this.pool.query<RegistrationRow>(
      `SELECT id, api_key_id, url, secret, events, created_at
       FROM webhook_registrations WHERE api_key_id = $1 ORDER BY created_at ASC`,
      [apiKeyId],
    );
    return rows.map((row) => this.mapRegistration(row));
  }

  async appendDeliveryAttempt(attempt: DeliveryAttempt): Promise<void> {
    await this.pool.query(
      `INSERT INTO webhook_delivery_log
         (id, registration_id, webhook_url, event, attempt_number, status_code, error, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        attempt.id,
        attempt.registrationId,
        attempt.webhookUrl,
        attempt.event,
        attempt.attemptNumber,
        attempt.statusCode ?? null,
        attempt.error ?? null,
        attempt.timestamp,
      ],
    );
  }

  async listDeliveryAttempts(): Promise<DeliveryAttempt[]> {
    const { rows } = await this.pool.query<DeliveryAttemptRow>(
      `SELECT id, registration_id, webhook_url, event, status_code, error, delivered_at, attempt_number
       FROM webhook_delivery_log ORDER BY delivered_at ASC`,
    );
    return rows.map((row) => this.mapAttempt(row));
  }

  async pruneDeliveryLog(maxEntries: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM webhook_delivery_log
       WHERE id IN (
         SELECT id FROM webhook_delivery_log
         ORDER BY delivered_at DESC
         OFFSET $1
       )`,
      [Math.max(0, Math.floor(maxEntries))],
    );
  }

  async saveDLQEntry(entry: DLQEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO webhook_dlq (id, registration_id, event, payload, attempts, failed_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         payload = EXCLUDED.payload,
         attempts = EXCLUDED.attempts,
         failed_at = EXCLUDED.failed_at`,
      [
        entry.id,
        entry.registration.id,
        entry.event,
        JSON.stringify(entry.payload),
        JSON.stringify(entry.attempts),
        entry.failedAt,
      ],
    );
  }

  async listDLQEntries(): Promise<DLQEntry[]> {
    const { rows } = await this.pool.query<DLQRow>(
      `SELECT d.id, d.registration_id, d.event, d.payload, d.attempts, d.failed_at,
              r.url AS registration_url, r.secret AS registration_secret,
              r.api_key_id AS registration_api_key_id, r.events AS registration_events,
              r.created_at AS registration_created_at
       FROM webhook_dlq d
       JOIN webhook_registrations r ON r.id = d.registration_id
       ORDER BY d.failed_at ASC`,
    );
    return rows.map((row) => this.mapDLQEntry(row));
  }

  async getDLQEntry(id: string): Promise<DLQEntry | undefined> {
    const { rows } = await this.pool.query<DLQRow>(
      `SELECT d.id, d.registration_id, d.event, d.payload, d.attempts, d.failed_at,
              r.url AS registration_url, r.secret AS registration_secret,
              r.api_key_id AS registration_api_key_id, r.events AS registration_events,
              r.created_at AS registration_created_at
       FROM webhook_dlq d
       JOIN webhook_registrations r ON r.id = d.registration_id
       WHERE d.id = $1`,
      [id],
    );
    return rows[0] ? this.mapDLQEntry(rows[0]) : undefined;
  }

  async deleteDLQEntry(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM webhook_dlq WHERE id = $1 RETURNING id', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  private mapRegistration(row: RegistrationRow): WebhookRegistration {
    return {
      id: row.id,
      url: row.url,
      secret: row.secret ?? '',
      apiKeyId: row.api_key_id ?? '',
      events: parseEvents(row.events),
      createdAt: Number(row.created_at),
    };
  }

  private mapAttempt(row: DeliveryAttemptRow): DeliveryAttempt {
    return {
      id: row.id,
      registrationId: row.registration_id,
      webhookUrl: row.webhook_url,
      event: row.event,
      statusCode: row.status_code ?? undefined,
      error: row.error ?? undefined,
      timestamp: Number(row.delivered_at),
      attemptNumber: row.attempt_number,
    };
  }

  private mapDLQEntry(row: DLQRow): DLQEntry {
    const attempts = parseJson(row.attempts);
    return {
      id: row.id,
      registration: {
        id: row.registration_id,
        url: row.registration_url,
        secret: row.registration_secret ?? '',
        apiKeyId: row.registration_api_key_id ?? '',
        events: parseEvents(row.registration_events),
        createdAt: Number(row.registration_created_at),
      },
      payload: parseJson(row.payload),
      event: row.event,
      attempts: Array.isArray(attempts) ? attempts as DeliveryAttempt[] : [],
      failedAt: Number(row.failed_at),
    };
  }
}
