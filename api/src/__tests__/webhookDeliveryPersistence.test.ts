import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { WebhookDeliveryRepository } from '../services/webhookDeliveryRepository';
import { WebhookDeliveryService } from '../services/webhookDelivery';

describe('persistent webhook registrations', () => {
  it('loads a registration with its API key id in a new service instance', async () => {
    const registrations = new Map<string, Record<string, unknown>>();
    const pool = {
      async query(sql: string, values: unknown[] = []) {
        if (sql.includes('INSERT INTO webhook_registrations')) {
          registrations.set(String(values[0]), {
            id: values[0],
            api_key_id: values[3],
            url: values[4],
            secret: values[5],
            events: values[6],
            created_at: values[7],
          });
          return { rows: [], rowCount: 1 };
        }

        if (sql.includes('FROM webhook_registrations WHERE api_key_id = $1')) {
          const rows = [...registrations.values()]
            .filter((row) => row.api_key_id === values[0])
            .map((row) => ({
              id: row.id,
              api_key_id: row.api_key_id,
              url: row.url,
              secret: row.secret,
              events: row.events,
              created_at: row.created_at,
            }));
          return { rows, rowCount: rows.length };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as Pool;

    const serviceA = new WebhookDeliveryService(new WebhookDeliveryRepository(pool));
    const registration = await serviceA.register({
      url: 'https://example.com/webhook',
      secret: 'persisted-secret',
      apiKeyId: 'owner-key-id',
      events: ['status.changed'],
    });

    const serviceB = new WebhookDeliveryService(new WebhookDeliveryRepository(pool));
    await expect(serviceB.getRegistrationsByApiKeyId('owner-key-id')).resolves.toEqual([registration]);
    await expect(serviceB.getRegistrationsByApiKeyId('another-key-id')).resolves.toEqual([]);
  });
});
