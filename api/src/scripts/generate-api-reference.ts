import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { openApiSpec } from '../openapi/spec';

type Operation = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  requestBody?: unknown;
  parameters?: Array<{ name: string; in: 'query' | 'path'; required?: boolean }>;
  responses?: Record<string, { description?: string }>;
};

type PostmanItem = {
  name: string;
  request: {
    method: string;
    header: Array<{ key: string; value: string }>;
    url: {
      raw: string;
      host: string[];
      path: string[];
      query?: Array<{ key: string; value: string; description?: string }>;
      variable?: Array<{ key: string; value: string }>;
    };
    body?: { mode: 'raw'; raw: string; options: { raw: { language: 'json' } } };
    description?: string;
  };
  event: Array<{ listen: string; script: { type: 'text/javascript'; exec: string[] } }>;
  response: Array<{
    name: string;
    originalRequest: PostmanItem['request'];
    status: string;
    code: number;
    header: Array<{ key: string; value: string }>;
    body: string;
  }>;
};

const repoRoot = resolve(__dirname, '../../..');
const outputDir = resolve(repoRoot, 'docs/api-reference');
const openApiOutput = resolve(outputDir, 'openapi.json');
const collectionOutput = resolve(outputDir, 'c-address-bridge.postman_collection.json');
const environmentOutput = resolve(outputDir, 'c-address-bridge.local.postman_environment.json');

const inputs: Record<string, { query?: Record<string, string>; path?: Record<string, string>; body?: unknown }> = {
  getQuote: { query: { sourceAsset: 'XLM', amount: '1000000', targetAddress: '{{targetCAddress}}' } },
  submitFunding: { body: { signedXdr: '{{signedXdr}}' } },
  prepareFunding: {
    body: {
      sourceAddress: '{{sourceAddress}}',
      targetAddress: '{{targetCAddress}}',
      tokenAddress: '{{tokenAddress}}',
      amount: '1000000',
      memo: 'bridge-payment',
    },
  },
  getTransactionStatus: { path: { txHash: '{{txHash}}' } },
  moonpayOfframp: {
    body: {
      currencyCode: 'xlm',
      walletAddress: '{{targetCAddress}}',
      walletNetwork: 'stellar',
      baseCurrencyAmount: 100,
      baseCurrencyCode: 'USD',
      email: 'user@example.com',
    },
  },
  transakOfframp: {
    body: {
      walletAddress: '{{targetCAddress}}',
      network: 'stellar',
      fiatCurrency: 'USD',
      cryptoCurrency: 'XLM',
      fiatAmount: 100,
      email: 'user@example.com',
      redirectURL: 'https://example.com/complete',
    },
  },
  cexRoute: {
    body: {
      exchange: 'binance',
      sourceAsset: 'XLM',
      amount: '10000000',
      targetCAddress: '{{targetCAddress}}',
      targetNetwork: 'stellar',
      memo: 'cex-withdrawal',
    },
  },
  createApiKey: {
    body: {
      name: 'my-integration',
      scopes: ['quote:read', 'fund:write', 'status:read'],
      ipWhitelist: [],
      expiresAt: null,
      rateLimit: 'standard',
    },
  },
  revokeApiKey: { path: { id: '{{apiKeyId}}' } },
};

const successes: Record<string, Record<string, unknown>> = {
  getQuote: { '200': { estimatedFee: '3000', expectedReceive: '997000', feeBps: 30, rate: '1.0' } },
  submitFunding: { '201': { status: 'pending', hash: '{{txHash}}', explorerUrl: 'https://stellar.expert/explorer/testnet/tx/{{txHash}}' } },
  prepareFunding: {
    '200': {
      instruction: 'Sign the returned transaction XDR, then submit it to POST /api/v2/fund.',
      simulation: { successful: true },
      params: { sourceAddress: '{{sourceAddress}}', targetAddress: '{{targetCAddress}}', tokenAddress: '{{tokenAddress}}', amount: '1000000', memo: 'bridge-payment' },
    },
  },
  getTransactionStatus: { '200': { status: 'success', hash: '{{txHash}}', explorerUrl: 'https://stellar.expert/explorer/testnet/tx/{{txHash}}' } },
  moonpayOfframp: { '200': { url: 'https://buy.moonpay.com?currencyCode=xlm&walletAddress={{targetCAddress}}' } },
  transakOfframp: { '200': { url: 'https://global.transak.com?cryptoCurrency=XLM&walletAddress={{targetCAddress}}' } },
  cexRoute: { '201': { exchange: 'binance', withdrawalAddress: '{{targetCAddress}}', memo: 'cex-withdrawal', network: 'stellar', amount: '10000000' } },
  createApiKey: { '201': { rawKey: 'cab_example_raw_key_store_securely', id: '{{apiKeyId}}', name: 'my-integration', scopes: ['quote:read', 'fund:write', 'status:read'] } },
  listApiKeys: { '200': { keys: [{ id: '{{apiKeyId}}', name: 'my-integration', scopes: ['quote:read', 'fund:write', 'status:read'], revoked: false }] } },
  revokeApiKey: { '200': { revoked: true } },
  health: { '200': { status: 'ok', timestamp: 1767225600000, circuits: { soroban: 'closed', moonpay: 'closed', transak: 'closed', cex: 'closed' } } },
};

function errorExample(status: string): unknown {
  if (status === '401') return { error: 'unauthorized', message: 'missing API key' };
  if (status === '403') return { error: 'forbidden', message: 'insufficient permissions' };
  if (status === '404') return { error: 'not_found', message: 'resource not found' };
  if (status === '429') return { error: 'rate_limited', message: 'rate limit exceeded' };
  if (status === '500') return { error: 'internal_error', message: 'upstream service error' };
  return { error: 'validation_error', message: 'invalid request', details: [{ path: 'field', message: 'required' }] };
}

function pathInfo(path: string, examples: Record<string, string> = {}) {
  const variables: Array<{ key: string; value: string }> = [];
  const rawPath = path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    variables.push({ key: name, value: examples[name] ?? `{{${name}}}` });
    return `:${name}`;
  });
  return { rawPath, path: rawPath.split('/').filter(Boolean), variables };
}

function requestFor(method: string, path: string, op: Operation): PostmanItem['request'] {
  const id = op.operationId ?? `${method}_${path}`;
  const example = inputs[id] ?? {};
  const info = pathInfo(path, example.path);
  const query = op.parameters
    ?.filter((p) => p.in === 'query')
    .map((p) => ({ key: p.name, value: example.query?.[p.name] ?? '', description: p.required ? 'Required' : 'Optional' }));
  const rawQuery = query && query.length > 0 ? `?${query.map((q) => `${q.key}=${q.value}`).join('&')}` : '';
  const request: PostmanItem['request'] = {
    method: method.toUpperCase(),
    header: [{ key: 'Accept', value: 'application/json' }],
    url: { raw: `{{baseUrl}}${info.rawPath}${rawQuery}`, host: ['{{baseUrl}}'], path: info.path },
    description: op.description,
  };
  if (query && query.length > 0) request.url.query = query;
  if (info.variables.length > 0) request.url.variable = info.variables;
  if (op.requestBody) {
    request.header.push({ key: 'Content-Type', value: 'application/json' });
    request.body = { mode: 'raw', raw: JSON.stringify(example.body ?? {}, null, 2), options: { raw: { language: 'json' } } };
  }
  return request;
}

function responsesFor(op: Operation, request: PostmanItem['request']): PostmanItem['response'] {
  const id = op.operationId ?? '';
  return Object.entries(op.responses ?? {}).map(([status, response]) => {
    const code = Number.parseInt(status, 10);
    const body = successes[id]?.[status] ?? (code >= 400 ? errorExample(status) : {});
    return {
      name: `${status} ${response.description ?? ''}`.trim(),
      originalRequest: request,
      status: response.description ?? status,
      code,
      header: [{ key: 'Content-Type', value: 'application/json' }],
      body: JSON.stringify(body, null, 2),
    };
  });
}

function collection() {
  const folders = new Map<string, { name: string; item: PostmanItem[] }>();
  for (const [path, pathItem] of Object.entries(openApiSpec.paths ?? {})) {
    for (const [method, op] of Object.entries(pathItem as Record<string, Operation>)) {
      const tag = op.tags?.[0] ?? 'API';
      const request = requestFor(method, path, op);
      const item: PostmanItem = {
        name: op.summary ?? `${method.toUpperCase()} ${path}`,
        request,
        event: [{ listen: 'test', script: { type: 'text/javascript', exec: [
          'pm.test("status code is documented", function () {',
          `  pm.expect([${Object.keys(op.responses ?? {}).join(', ')}]).to.include(pm.response.code);`,
          '});',
          'pm.test("JSON responses are valid", function () {',
          '  if ((pm.response.headers.get("Content-Type") || "").includes("application/json")) pm.response.json();',
          '});',
        ] } }],
        response: responsesFor(op, request),
      };
      if (!folders.has(tag)) folders.set(tag, { name: tag, item: [] });
      folders.get(tag)?.item.push(item);
    }
  }
  return {
    info: {
      name: 'C-Address Onboarding Bridge API',
      description: 'Runnable API reference generated from api/src/openapi/spec.ts.',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'apikey', apikey: [
      { key: 'key', value: 'X-API-Key', type: 'string' },
      { key: 'value', value: '{{apiKey}}', type: 'string' },
      { key: 'in', value: 'header', type: 'string' },
    ] },
    event: [
      { listen: 'prerequest', script: { type: 'text/javascript', exec: [
        'const network = pm.environment.get("network") || "local";',
        'const networkBaseUrl = pm.environment.get(`${network}BaseUrl`);',
        'if (networkBaseUrl) pm.environment.set("baseUrl", networkBaseUrl);',
        'if (!pm.environment.get("apiKey")) pm.environment.set("apiKey", "test-api-key-123");',
        'pm.request.headers.upsert({ key: "X-API-Key", value: pm.environment.get("apiKey") });',
      ] } },
      { listen: 'test', script: { type: 'text/javascript', exec: ['pm.test("response time under 5s", function () {', '  pm.expect(pm.response.responseTime).to.be.below(5000);', '});'] } },
    ],
    variable: [{ key: 'baseUrl', value: '{{localBaseUrl}}' }, { key: 'apiKey', value: '{{apiKey}}' }],
    item: [...folders.values()],
  };
}

function environment() {
  return {
    name: 'C-Address Bridge - Local',
    values: [
      { key: 'network', value: 'local', enabled: true },
      { key: 'baseUrl', value: 'http://localhost:3001', enabled: true },
      { key: 'localBaseUrl', value: 'http://localhost:3001', enabled: true },
      { key: 'testnetBaseUrl', value: 'https://testnet-api.example.com', enabled: true },
      { key: 'mainnetBaseUrl', value: 'https://api.example.com', enabled: true },
      { key: 'apiKey', value: 'test-api-key-123', type: 'secret', enabled: true },
      { key: 'apiKeyId', value: '00000000-0000-4000-8000-000000000000', enabled: true },
      { key: 'sourceAddress', value: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW', enabled: true },
      { key: 'targetCAddress', value: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW', enabled: true },
      { key: 'tokenAddress', value: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW', enabled: true },
      { key: 'signedXdr', value: 'AAAAAgAAAABexampleSignedTransactionXdr', type: 'secret', enabled: true },
      { key: 'txHash', value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', enabled: true },
    ],
    _postman_variable_scope: 'environment',
    _postman_exported_using: 'C-Address Bridge generator',
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function generateApiReferenceFiles(write = true) {
  const files = new Map<string, string>([
    [openApiOutput, json(openApiSpec)],
    [collectionOutput, json(collection())],
    [environmentOutput, json(environment())],
  ]);
  if (write) {
    for (const [file, contents] of files) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents);
    }
  }
  return files;
}

export function assertApiReferenceFilesCurrent(): string[] {
  const files = generateApiReferenceFiles(false);
  const stale: string[] = [];
  for (const [file, contents] of files) {
    try {
      if (readFileSync(file, 'utf8') !== contents) stale.push(file);
    } catch {
      stale.push(file);
    }
  }
  return stale;
}

if (require.main === module) {
  generateApiReferenceFiles(true);
  console.log(`API reference files written to ${outputDir}`);
}
