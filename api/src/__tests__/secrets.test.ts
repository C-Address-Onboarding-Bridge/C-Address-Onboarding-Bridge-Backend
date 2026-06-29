import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { secretSchema } from '../secrets/schema';

const managedEnv = [
  'SECRETS_PROVIDER',
  'SECRETS_SERVICE_NAME',
  'LOCAL_SECRETS_FILE',
  'LOCAL_SECRETS_KEY',
  'LOCAL_SECRETS_PLAIN_FILE',
  'SECRETS_AUDIT_LOG',
  'MOONPAY_API_KEY',
  'DATABASE_URL',
  'JOBS_ENABLED',
];

afterEach(() => {
  vi.resetModules();
  for (const key of managedEnv) delete process.env[key];
});

describe('secrets management', () => {
  it('maps every config env var into the centralized schema', () => {
    const required = [
      'SOROBAN_RPC_URL',
      'SOROBAN_RPC_URLS',
      'MOONPAY_API_KEY',
      'MOONPAY_SECRET_KEY',
      'TRANSAK_API_KEY',
      'TRANSAK_WEBHOOK_SECRET',
      'API_KEYS',
      'REDIS_URL',
      'DATABASE_URL',
      'LOGTAIL_TOKEN',
      'WEBHOOK_SIGNING_SECRET',
    ];
    const names = new Set(secretSchema.map((definition) => definition.env));
    for (const name of required) expect(names.has(name), `${name} missing from secret schema`).toBe(true);
  });

  it('loads service-scoped values from an encrypted local secret file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-secrets-'));
    const plain = join(dir, 'secrets.json');
    const encrypted = join(dir, 'secrets.enc');
    const audit = join(dir, 'audit.jsonl');
    writeFileSync(plain, JSON.stringify({ MOONPAY_API_KEY: 'moonpay-from-vault', DATABASE_URL: 'postgres://user:pass@localhost/db', JOBS_ENABLED: 'true' }));

    execFileSync('node', ['scripts/secrets.mjs', 'encrypt'], {
      cwd: join(__dirname, '../../..'),
      env: { ...process.env, LOCAL_SECRETS_KEY: 'test-local-key', LOCAL_SECRETS_PLAIN_FILE: plain, LOCAL_SECRETS_FILE: encrypted, SECRETS_AUDIT_LOG: audit },
    });

    process.env.SECRETS_PROVIDER = 'local-encrypted';
    process.env.SECRETS_SERVICE_NAME = 'api';
    process.env.LOCAL_SECRETS_FILE = encrypted;
    process.env.LOCAL_SECRETS_KEY = 'test-local-key';
    process.env.SECRETS_AUDIT_LOG = audit;

    const { initializeSecrets } = await import('../secrets/manager');
    initializeSecrets();

    expect(process.env.MOONPAY_API_KEY).toBe('moonpay-from-vault');
    expect(process.env.DATABASE_URL).toBe('postgres://user:pass@localhost/db');
    expect(process.env.JOBS_ENABLED).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
   });
 });
