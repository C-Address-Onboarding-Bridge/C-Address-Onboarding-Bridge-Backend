import { describe, it, expect, afterEach, vi } from 'vitest';
import IORedis from 'ioredis';

process.env.NODE_ENV = 'test';

// #1051: the previous hand-rolled parser dropped `rediss://` (TLS), the ACL
// username, and the db. These tests pin ioredis' behaviour so that if the
// connection factory ever regresses back to a manual parser, they fail loudly.
describe('createRedisConnection (#1051)', () => {
  const opened: IORedis[] = [];

  afterEach(() => {
    for (const c of opened.splice(0)) {
      try { c.disconnect(); } catch { /* ignore */ }
    }
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('rediss://user:pw@host:6380/2 yields tls + username + password + port + db', () => {
    const conn = new IORedis('rediss://user:pw@host:6380/2', {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    opened.push(conn);

    expect(conn.options.username).toBe('user');
    expect(conn.options.password).toBe('pw');
    expect(conn.options.port).toBe(6380);
    expect(conn.options.db).toBe(2);
    // ioredis sets `tls` to an object (or `{}`) when the scheme is rediss://.
    expect(conn.options.tls).toBeDefined();
    expect(typeof conn.options.tls).toBe('object');
  });

  it('createRedisConnection() forwards config.redis.url and sets maxRetriesPerRequest: null', async () => {
    vi.resetModules();
    vi.stubEnv('REDIS_URL', 'rediss://user:pw@host:6380/2');

    // Import config *after* stubbing so it picks up the env var.
    const { config } = await import('../config');
    expect(config.redis.url).toBe('rediss://user:pw@host:6380/2');

    const { createRedisConnection } = await import('../jobs/connection');
    const conn = createRedisConnection({ lazyConnect: true });
    opened.push(conn);

    expect(conn.options.username).toBe('user');
    expect(conn.options.password).toBe('pw');
    expect(conn.options.port).toBe(6380);
    expect(conn.options.db).toBe(2);
    expect(conn.options.tls).toBeDefined();
    // BullMQ requires this on Worker connections; the factory sets it by default.
    expect(conn.options.maxRetriesPerRequest).toBeNull();
  });

  it('plain redis:// URL still produces a non-TLS connection', async () => {
    vi.resetModules();
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');

    const { createRedisConnection } = await import('../jobs/connection');
    const conn = createRedisConnection({ lazyConnect: true });
    opened.push(conn);

    expect(conn.options.port).toBe(6379);
    expect(conn.options.db).toBe(0);
    expect(conn.options.tls).toBeUndefined();
  });
});
