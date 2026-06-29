#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const encryptedFile = process.env.LOCAL_SECRETS_FILE || '.secrets.local.enc';
const plainFile = process.env.LOCAL_SECRETS_PLAIN_FILE || '.secrets.local.json';
const auditFile = process.env.SECRETS_AUDIT_LOG || 'logs/secrets-audit.jsonl';

const schema = [
  ['API_KEYS', 'auth/api-keys', true, true, 30],
  ['SOROBAN_RPC_URL', 'soroban/rpc-url', true, true, 90],
  ['SOROBAN_RPC_URLS', 'soroban/rpc-urls', true, true, 90],
  ['MOONPAY_API_KEY', 'providers/moonpay/api-key', true, true, 90],
  ['MOONPAY_SECRET_KEY', 'providers/moonpay/secret-key', true, true, 90],
  ['TRANSAK_API_KEY', 'providers/transak/api-key', true, true, 90],
  ['TRANSAK_WEBHOOK_SECRET', 'providers/transak/webhook-secret', true, true, 90],
  ['REDIS_URL', 'redis/url', true, true, 90],
  ['DATABASE_URL', 'database/url', true, true, 90],
  ['LOGTAIL_TOKEN', 'logging/logtail-token', true, true, 90],
  ['WEBHOOK_SIGNING_SECRET', 'webhooks/signing-secret', true, true, 30],
];

function key() {
  const material = process.env.LOCAL_SECRETS_KEY;
  if (!material) throw new Error('LOCAL_SECRETS_KEY is required');
  return createHash('sha256').update(material).digest();
}

function audit(action, details = {}) {
  mkdirSync(dirname(auditFile), { recursive: true });
  writeFileSync(auditFile, `${JSON.stringify({ ts: new Date().toISOString(), action, ...details })}\n`, { flag: 'a' });
}

function encrypt() {
  const input = JSON.parse(readFileSync(plainFile, 'utf8'));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(input, null, 2), 'utf8'), cipher.final()]);
  const payload = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  writeFileSync(encryptedFile, `${JSON.stringify(payload, null, 2)}\n`);
  audit('local-secrets-encrypt', { file: encryptedFile });
  console.log(`encrypted ${plainFile} -> ${encryptedFile}`);
}

function decrypt() {
  const payload = JSON.parse(readFileSync(encryptedFile, 'utf8'));
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const data = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
  console.log(data);
  audit('local-secrets-decrypt', { file: encryptedFile });
}

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bghp_[A-Za-z0-9_]{36,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bcab_[a-f0-9]{32,}\b/,
  /(?:api[_-]?key|secret|token|password|private[_-]?key)\s*[:=]\s*['\"]?[A-Za-z0-9_./+=:@-]{12,}/i,
  /postgres(?:ql)?:\/\/[^\s'\"]+:[^\s'\"]+@/i,
  /redis:\/\/[^\s'\"]+:[^\s'\"]+@/i,
];

function scan() {
  const scanAll = process.argv.includes('--all');
  const files = scanAll ? execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean) : stagedFiles();
  const allowed = [/^package-lock\.json$/, /^docs\/api-reference\//, /^api\/src\/__tests__\//, /^api\/tests\//, /^sdk\/tests\//];
  const findings = [];
  for (const file of files) {
    if (!existsSync(file) || allowed.some((pattern) => pattern.test(file))) continue;
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      const isEnvReference = /process\.env\.[A-Z0-9_]+/.test(line);
      const isConfigReference = /\bconfig\.[A-Za-z0-9_.]*(?:apiKey|secretKey|token|password|privateKey)\b/i.test(line);
      const isObjectReference = /[:=]\s*(?:params|config|this|input|req\.body|process\.env)\.[A-Za-z0-9_.]*(?:apiKey|secret|secretKey|token|password|privateKey)\b/i.test(line);
      const isKnownPlaceholder = /[:=]\s*['\"]?(?:benchmark-api-key|dev-api-key|test-api-key-123|replace-me)['\"]?\s*$/i.test(line);
      if (isKnownPlaceholder) return;
      if ((isEnvReference || isConfigReference || isObjectReference) && /(?:api[_-]?key|secret|token|password|private[_-]?key)/i.test(line)) return;
      if (secretPatterns.some((pattern) => pattern.test(line))) findings.push(`${file}:${index + 1}`);
    });
  }
  if (findings.length > 0) {
    console.error('Potential secret detected. Remove it or add a tightly-scoped allowlist entry in scripts/secrets.mjs.');
    findings.forEach((finding) => console.error(`  ${finding}`));
    process.exit(1);
  }
  console.log(`secret scan passed (${files.length} ${scanAll ? 'tracked' : 'staged'} files checked)`);
}

function providerPath(path) {
  return `${process.env.SECRETS_PATH_PREFIX || 'c-address-bridge/api'}/${path}`;
}

function applyRotation(env, path, value) {
  const provider = process.env.SECRETS_PROVIDER || 'env';
  const fullPath = providerPath(path);
  if (provider === 'aws') {
    execFileSync('aws', ['secretsmanager', 'put-secret-value', '--secret-id', fullPath, '--secret-string', JSON.stringify({ [env]: value })], { stdio: 'inherit' });
    return;
  }
  if (provider === 'gcp') {
    const child = spawnSync('gcloud', ['secrets', 'versions', 'add', fullPath.replace(/\//g, '-'), '--data-file=-'], { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
    if (child.status !== 0) throw new Error('gcloud secret rotation failed');
    return;
  }
  if (provider === 'vault') {
    execFileSync('vault', ['kv', 'put', fullPath, `${env}=${value}`], { stdio: 'inherit' });
    return;
  }
  throw new Error('set SECRETS_PROVIDER to aws, gcp, or vault to apply rotation');
}

function rotate() {
  const target = process.argv[3];
  if (!target) throw new Error('usage: node scripts/secrets.mjs rotate <ENV_NAME> [--apply]');
  const definition = schema.find(([env]) => env === target);
  if (!definition) throw new Error(`unknown critical secret: ${target}`);
  const value = target === 'API_KEYS' ? `cab_${randomBytes(32).toString('hex')}` : randomBytes(32).toString('base64url');
  if (process.argv.includes('--apply')) {
    applyRotation(target, definition[1], value);
    audit('secret-rotate-applied', { env: target, path: definition[1], provider: process.env.SECRETS_PROVIDER });
    console.log(`rotated ${target} at ${providerPath(definition[1])}`);
    return;
  }
  console.log(value);
  audit('secret-rotate-generated', { env: target, path: definition[1] });
}

function printSchema() {
  console.table(schema.map(([env, path, sensitive, critical, rotationDays]) => ({ env, path, sensitive, critical, rotationDays })));
}

const command = process.argv[2];
if (command === 'encrypt') encrypt();
else if (command === 'decrypt') decrypt();
else if (command === 'scan') scan();
else if (command === 'rotate') rotate();
else if (command === 'schema') printSchema();
else {
  console.error('usage: node scripts/secrets.mjs <encrypt|decrypt|scan|rotate|schema>');
  process.exit(1);
}
