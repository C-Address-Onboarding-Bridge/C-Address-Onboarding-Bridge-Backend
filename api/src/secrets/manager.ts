import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { createDecipheriv, createHash } from 'crypto';
import { definitionsForService, SecretDefinition, SecretsProviderName } from './schema';

interface SecretAuditEvent {
  ts: string;
  provider: string;
  service: string;
  env: string;
  path: string;
  result: 'loaded' | 'missing' | 'error' | 'skipped-existing';
  message?: string;
}

let initialized = false;

function providerName(): SecretsProviderName {
  return (process.env.SECRETS_PROVIDER || 'env') as SecretsProviderName;
}

function prefix(): string {
  return process.env.SECRETS_PATH_PREFIX || 'c-address-bridge/api';
}

function audit(event: SecretAuditEvent): void {
  const file = process.env.SECRETS_AUDIT_LOG || 'logs/secrets-audit.jsonl';
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {
    // Secret loading must not fail because the local audit sink is unavailable.
  }
}

function decryptLocalFile(): Record<string, unknown> {
  const file = process.env.LOCAL_SECRETS_FILE || '.secrets.local.enc';
  if (!existsSync(file)) return {};
  const keyMaterial = process.env.LOCAL_SECRETS_KEY;
  if (!keyMaterial) throw new Error('LOCAL_SECRETS_KEY is required for local-encrypted secrets');
  const payload = JSON.parse(readFileSync(file, 'utf8')) as { iv: string; tag: string; data: string };
  const key = createHash('sha256').update(keyMaterial).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted) as Record<string, unknown>;
}

function parseSecretValue(raw: string, definition: SecretDefinition): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  const value = parsed[definition.env] ?? parsed.value ?? parsed.secret;
  return value === undefined || value === null ? '' : String(value);
}

function readCloudSecret(provider: SecretsProviderName, secretPath: string, definition: SecretDefinition): string {
  const fullPath = `${prefix()}/${secretPath}`;
  if (provider === 'aws') {
    const raw = execFileSync('aws', ['secretsmanager', 'get-secret-value', '--secret-id', fullPath, '--query', 'SecretString', '--output', 'text'], { encoding: 'utf8' });
    return parseSecretValue(raw, definition);
  }
  if (provider === 'gcp') {
    const raw = execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret', fullPath.replace(/\//g, '-')], { encoding: 'utf8' });
    return parseSecretValue(raw, definition);
  }
  if (provider === 'vault') {
    const raw = execFileSync('vault', ['kv', 'get', '-format=json', fullPath], { encoding: 'utf8' });
    const parsed = JSON.parse(raw) as { data?: { data?: Record<string, unknown> } };
    const value = parsed.data?.data?.[definition.env] ?? parsed.data?.data?.value;
    return value === undefined || value === null ? '' : String(value);
  }
  return '';
}

function readSecret(provider: SecretsProviderName, definition: SecretDefinition, localSecrets: Record<string, unknown>): string {
  if (provider === 'local-encrypted') {
    const value = localSecrets[definition.env] ?? localSecrets[definition.path];
    return value === undefined || value === null ? '' : String(value);
  }
  return readCloudSecret(provider, definition.path, definition);
}

export function initializeSecrets(): void {
  if (initialized) return;
  initialized = true;

  const provider = providerName();
  if (provider === 'env') return;

  const service = process.env.SECRETS_SERVICE_NAME || process.env.SERVICE_NAME || 'api';
  const definitions = definitionsForService(service);
  const localSecrets = provider === 'local-encrypted' ? decryptLocalFile() : {};

  for (const definition of definitions) {
    const baseEvent = {
      ts: new Date().toISOString(),
      provider,
      service,
      env: definition.env,
      path: `${prefix()}/${definition.path}`,
    };

    if (process.env[definition.env]) {
      audit({ ...baseEvent, result: 'skipped-existing' });
      continue;
    }

    try {
      const value = readSecret(provider, definition, localSecrets);
      if (!value) {
        audit({ ...baseEvent, result: 'missing' });
        continue;
      }
      process.env[definition.env] = value;
      audit({ ...baseEvent, result: 'loaded' });
    } catch (err) {
      audit({ ...baseEvent, result: 'error', message: err instanceof Error ? err.message : String(err) });
      if (definition.critical || process.env.SECRETS_STRICT === 'true') throw err;
    }
  }
}

export function localSecretFilePath(): string {
  return resolve(process.env.LOCAL_SECRETS_FILE || '.secrets.local.enc');
}
