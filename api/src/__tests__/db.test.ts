import { describe, it, expect, vi } from 'vitest';

process.env.NODE_ENV = 'test';

vi.mock('../config', () => ({
  config: {
    database: { url: '', poolMax: 5, idleTimeoutMs: 30000, connectionTimeoutMs: 5000, ssl: false },
    logLevel: 'silent',
    logging: { serviceName: 'test', version: '0.0.0', environment: 'test', sensitiveFields: [], bodyTruncateLength: 200 },
  },
}));

import { getPool, dbHealthCheck } from '../services/db';

describe('db service (no DATABASE_URL)', () => {
  it('getPool returns null when DATABASE_URL is not set', () => {
    const pool = getPool();
    expect(pool).toBeNull();
  });

  it('dbHealthCheck returns ok (skip) when database not configured', async () => {
    const result = await dbHealthCheck();
    expect(result.ok).toBe(true);
  });
});
