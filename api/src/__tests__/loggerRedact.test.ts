import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.SOROBAN_RPC_URL = 'https://soroban-rpc.testnet.stellar.org';
process.env.BRIDGE_FEE_BPS = '30';
process.env.API_KEYS = 'test-api-key-123';

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  json: vi.fn().mockResolvedValue({}),
  text: vi.fn().mockResolvedValue('ok'),
}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete process.env.LOG_SENSITIVE_FIELDS;
});

describe('logger redaction paths', () => {
  it('accepts configured field names that are not bare identifiers', async () => {
    // `x-api-key` is part of the default LOG_SENSITIVE_FIELDS list; pino rejects
    // it as a redact path unless it is quoted with bracket notation.
    process.env.LOG_SENSITIVE_FIELDS = 'apiKey,x-api-key,x-forwarded-for';

    await expect(import('../logger')).resolves.toBeDefined();
  });

  it('builds a logger with the default sensitive field list', async () => {
    const { logger } = await import('../logger');

    expect(typeof logger.info).toBe('function');
  });
});
