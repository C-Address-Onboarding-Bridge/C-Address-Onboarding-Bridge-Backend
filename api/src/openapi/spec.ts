import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'ApiKeyAuth', {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
  description: 'API key for authenticating requests. Obtainable via POST /api/v1/keys.',
});

// ── Reusable schemas ──────────────────────────────────────────────────────────

const StellarAddress = z
  .string()
  .regex(/^[GC][A-Z2-7]{55}$/)
  .openapi({ example: 'GABCDE...WXYZ', description: 'Stellar/C-Address (56-char base32)' });

const StroopsAmount = z
  .string()
  .regex(/^\d+$/)
  .openapi({ example: '1000000', description: 'Amount in stroops (1 XLM = 10,000,000 stroops)' });

const TxHash = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .openapi({ example: 'a1b2c3d4...', description: '64-char hex transaction hash' });

const ErrorResponse = registry.register(
  'ErrorResponse',
  z
    .object({
      error: z.string().openapi({ example: 'validation_error' }),
      message: z.string().optional().openapi({ example: 'invalid request' }),
      details: z
        .array(z.object({ path: z.string(), message: z.string() }))
        .optional(),
    })
    .openapi({ title: 'ErrorResponse' }),
);

const TxStatusResponse = registry.register(
  'TxStatusResponse',
  z
    .object({
      status: z.enum(['pending', 'success', 'failed']),
      hash: TxHash,
      explorerUrl: z.string().url().optional(),
      explorerUrls: z.array(z.string().url()).optional(),
      error: z.string().optional(),
    })
    .openapi({ title: 'TxStatusResponse' }),
);

// ── Quote ─────────────────────────────────────────────────────────────────────

const QuoteParams = registry.register(
  'QuoteParams',
  z
    .object({
      sourceAsset: z.string().min(1).openapi({ example: 'XLM' }),
      amount: StroopsAmount,
      targetAddress: StellarAddress,
    })
    .openapi({ title: 'QuoteParams' }),
);

const QuoteResponse = registry.register(
  'QuoteResponse',
  z
    .object({
      estimatedFee: z.string().openapi({ example: '3000' }),
      expectedReceive: z.string().openapi({ example: '997000' }),
      feeBps: z.number().int().openapi({ example: 30 }),
      rate: z.string().openapi({ example: '1.0' }),
    })
    .openapi({ title: 'QuoteResponse' }),
);

registry.registerPath({
  method: 'get',
  path: '/api/v2/quote',
  operationId: 'getQuote',
  summary: 'Get a fee quote for a funding transaction',
  description:
    'Returns estimated fee, expected receive amount, and exchange rate for a given asset and amount. Results are cached for 30 seconds.',
  tags: ['Quote'],
  security: [{ ApiKeyAuth: ['quote:read'] }],
  request: { query: QuoteParams },
  responses: {
    200: {
      description: 'Quote calculated successfully',
      content: { 'application/json': { schema: QuoteResponse } },
    },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorResponse } } },
    429: { description: 'Rate limit exceeded', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

// ── Fund ──────────────────────────────────────────────────────────────────────

const FundRequest = registry.register(
  'FundRequest',
  z
    .object({
      signedXdr: z
        .string()
        .min(1)
        .openapi({ example: 'AAAAAgAAAABxy...', description: 'Base64-encoded signed Stellar transaction XDR' }),
    })
    .openapi({ title: 'FundRequest' }),
);

const FundPrepareRequest = registry.register(
  'FundPrepareRequest',
  z
    .object({
      sourceAddress: StellarAddress,
      targetAddress: StellarAddress,
      tokenAddress: StellarAddress.openapi({ description: 'Token contract address' }),
      amount: StroopsAmount,
      memo: z.string().max(64).optional().openapi({ example: 'bridge-payment' }),
    })
    .openapi({ title: 'FundPrepareRequest' }),
);

registry.registerPath({
  method: 'post',
  path: '/api/v2/fund',
  operationId: 'submitFunding',
  summary: 'Submit a signed funding transaction',
  description:
    'Submits a pre-signed Stellar transaction XDR to the Soroban bridge contract. Use POST /api/v2/fund/prepare to build the transaction first.',
  tags: ['Fund'],
  security: [{ ApiKeyAuth: ['fund:write'] }],
  request: { body: { content: { 'application/json': { schema: FundRequest } } } },
  responses: {
    201: {
      description: 'Transaction submitted',
      content: { 'application/json': { schema: TxStatusResponse } },
    },
    400: { description: 'Invalid XDR or validation error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Soroban RPC error', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v2/fund/prepare',
  operationId: 'prepareFunding',
  summary: 'Prepare an unsigned funding transaction for signing',
  description:
    'Simulates the contract call and returns an unsigned transaction XDR for the client to sign. Sign this with your wallet and POST it to /api/v2/fund.',
  tags: ['Fund'],
  security: [{ ApiKeyAuth: ['fund:write'] }],
  request: { body: { content: { 'application/json': { schema: FundPrepareRequest } } } },
  responses: {
    200: {
      description: 'Unsigned transaction ready for signing',
      content: {
        'application/json': {
          schema: z.object({
            instruction: z.string(),
            simulation: z.unknown(),
            params: FundPrepareRequest,
          }).openapi({ title: 'FundPrepareResponse' }),
        },
      },
    },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

// ── Status ────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/api/v2/status/{txHash}',
  operationId: 'getTransactionStatus',
  summary: 'Poll transaction status by hash',
  description:
    'Returns the current on-chain status of a Soroban transaction. Poll this endpoint until status is `success` or `failed`.',
  tags: ['Status'],
  security: [{ ApiKeyAuth: ['status:read'] }],
  request: {
    params: z.object({ txHash: TxHash }).openapi({ title: 'StatusParams' }),
  },
  responses: {
    200: {
      description: 'Transaction status',
      content: { 'application/json': { schema: TxStatusResponse } },
    },
    400: { description: 'Invalid tx hash', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

// ── Offramp ───────────────────────────────────────────────────────────────────

const MoonpayOfframpRequest = registry.register(
  'MoonpayOfframpRequest',
  z
    .object({
      currencyCode: z.string().default('xlm').openapi({ example: 'xlm' }),
      walletAddress: StellarAddress,
      walletNetwork: z.string().default('stellar').openapi({ example: 'stellar' }),
      baseCurrencyAmount: z.number().positive().optional().openapi({ example: 100 }),
      baseCurrencyCode: z.string().optional().openapi({ example: 'USD' }),
      email: z.string().email().optional().openapi({ example: 'user@example.com' }),
    })
    .openapi({ title: 'MoonpayOfframpRequest' }),
);

const TransakOfframpRequest = registry.register(
  'TransakOfframpRequest',
  z
    .object({
      walletAddress: StellarAddress,
      network: z.string().default('stellar').openapi({ example: 'stellar' }),
      fiatCurrency: z.string().optional().openapi({ example: 'USD' }),
      cryptoCurrency: z.string().optional().openapi({ example: 'XLM' }),
      fiatAmount: z.number().positive().optional().openapi({ example: 100 }),
      email: z.string().email().optional().openapi({ example: 'user@example.com' }),
      redirectURL: z.string().url().optional(),
    })
    .openapi({ title: 'TransakOfframpRequest' }),
);

const WidgetUrlResponse = registry.register(
  'WidgetUrlResponse',
  z.object({ url: z.string().url() }).openapi({ title: 'WidgetUrlResponse' }),
);

registry.registerPath({
  method: 'post',
  path: '/api/v2/offramp/moonpay',
  operationId: 'moonpayOfframp',
  summary: 'Generate a MoonPay offramp widget URL',
  description: 'Returns a pre-filled MoonPay widget URL for converting XLM to fiat.',
  tags: ['Offramp'],
  security: [{ ApiKeyAuth: ['offramp:write'] }],
  request: { body: { content: { 'application/json': { schema: MoonpayOfframpRequest } } } },
  responses: {
    200: { description: 'Widget URL', content: { 'application/json': { schema: WidgetUrlResponse } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v2/offramp/transak',
  operationId: 'transakOfframp',
  summary: 'Generate a Transak offramp widget URL',
  description: 'Returns a pre-filled Transak widget URL for converting XLM to fiat.',
  tags: ['Offramp'],
  security: [{ ApiKeyAuth: ['offramp:write'] }],
  request: { body: { content: { 'application/json': { schema: TransakOfframpRequest } } } },
  responses: {
    200: { description: 'Widget URL', content: { 'application/json': { schema: WidgetUrlResponse } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

// ── CEX ───────────────────────────────────────────────────────────────────────

const CexRouteRequest = registry.register(
  'CexRouteRequest',
  z
    .object({
      exchange: z.enum(['binance', 'coinbase', 'kraken', 'generic']).openapi({ example: 'binance' }),
      sourceAsset: z.string().min(1).openapi({ example: 'XLM' }),
      amount: StroopsAmount,
      targetCAddress: StellarAddress,
      targetNetwork: z.string().default('stellar'),
      memo: z.string().max(64).optional(),
    })
    .openapi({ title: 'CexRouteRequest' }),
);

registry.registerPath({
  method: 'post',
  path: '/api/v2/cex/route',
  operationId: 'cexRoute',
  summary: 'Get CEX withdrawal routing instructions',
  description: 'Returns withdrawal configuration for routing from a supported CEX to a C-Address.',
  tags: ['CEX'],
  security: [{ ApiKeyAuth: ['cex:read'] }],
  request: { body: { content: { 'application/json': { schema: CexRouteRequest } } } },
  responses: {
    201: {
      description: 'CEX withdrawal route',
      content: {
        'application/json': {
          schema: z.object({
            exchange: z.string(),
            withdrawalAddress: z.string(),
            memo: z.string().optional(),
            network: z.string(),
            amount: z.string(),
          }).openapi({ title: 'CexRouteResponse' }),
        },
      },
    },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

// ── API Keys ──────────────────────────────────────────────────────────────────

const CreateKeyRequest = registry.register(
  'CreateKeyRequest',
  z
    .object({
      name: z.string().min(1).openapi({ example: 'my-integration' }),
      scopes: z
        .array(
          z.enum(['quote:read', 'fund:write', 'status:read', 'offramp:write', 'cex:read', 'admin:keys']),
        )
        .min(1)
        .openapi({ example: ['quote:read', 'fund:write', 'status:read'] }),
      ipWhitelist: z.array(z.string()).optional().openapi({ example: ['192.168.1.0/24'] }),
      expiresAt: z.number().int().nullable().optional().openapi({ example: 1893456000000 }),
      rateLimit: z.enum(['low', 'standard', 'high']).optional().openapi({ example: 'standard' }),
    })
    .openapi({ title: 'CreateKeyRequest' }),
);

registry.registerPath({
  method: 'post',
  path: '/api/v1/keys',
  operationId: 'createApiKey',
  summary: 'Create a new API key',
  description: 'Creates an API key with specified scopes. The raw key is only returned once — store it securely.',
  tags: ['API Keys'],
  security: [{ ApiKeyAuth: ['admin:keys'] }],
  request: { body: { content: { 'application/json': { schema: CreateKeyRequest } } } },
  responses: {
    201: {
      description: 'API key created',
      content: {
        'application/json': {
          schema: z.object({
            rawKey: z.string().openapi({ description: 'Store this — it cannot be retrieved again' }),
            id: z.string(),
            name: z.string(),
            scopes: z.array(z.string()),
          }).openapi({ title: 'CreateKeyResponse' }),
        },
      },
    },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/keys',
  operationId: 'listApiKeys',
  summary: 'List all API keys',
  tags: ['API Keys'],
  security: [{ ApiKeyAuth: ['admin:keys'] }],
  responses: {
    200: {
      description: 'List of keys',
      content: {
        'application/json': {
          schema: z.object({ keys: z.array(z.unknown()) }).openapi({ title: 'KeyListResponse' }),
        },
      },
    },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/keys/{id}',
  operationId: 'revokeApiKey',
  summary: 'Revoke an API key',
  tags: ['API Keys'],
  security: [{ ApiKeyAuth: ['admin:keys'] }],
  request: {
    params: z.object({ id: z.string().uuid().openapi({ example: 'uuid-v4' }) }).openapi({ title: 'KeyIdParam' }),
  },
  responses: {
    200: {
      description: 'Key revoked',
      content: {
        'application/json': {
          schema: z.object({ revoked: z.boolean() }).openapi({ title: 'RevokeKeyResponse' }),
        },
      },
    },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Key not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

// ── Health ────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/health',
  operationId: 'health',
  summary: 'Server health check',
  description: 'Returns server health and circuit breaker states. Returns 503 during graceful shutdown.',
  tags: ['Health'],
  responses: {
    200: {
      description: 'Healthy',
      content: {
        'application/json': {
          schema: z.object({
            status: z.enum(['ok', 'shutting_down']),
            timestamp: z.number(),
            circuits: z.record(z.string()),
          }).openapi({ title: 'HealthResponse' }),
        },
      },
    },
    503: { description: 'Shutting down', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

// ── Build ─────────────────────────────────────────────────────────────────────

const generator = new OpenApiGeneratorV31(registry.definitions);

export const openApiSpec = generator.generateDocument({
  openapi: '3.1.0',
  info: {
    title: 'C-Address Onboarding Bridge API',
    version: '2.0.0',
    description: `
Bridge API for seamless C-Address onboarding on the Stellar network.

## Authentication

All endpoints (except \`/health\` and webhooks) require an **API key** in the \`X-API-Key\` header.

\`\`\`
X-API-Key: your-api-key-here
\`\`\`

Keys are scoped — you need the matching scope for each endpoint (e.g. \`quote:read\` for the quote endpoint).

## Rate Limits

| Scope | Limit |
|-------|-------|
| quote | 30 req/min |
| fund, offramp, cex, status | 100 req/min |
| admin | 500 req/min |

Rate limit headers (\`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\`) are returned on every response.

## Idempotency

Funding submissions are idempotent — retrying with the same signed XDR will return the existing result.

## Versioning

The API supports versioned paths (\`/api/v1/\`, \`/api/v2/\`) and content-type negotiation via the \`Accept: application/vnd.bridge+json; version=2\` header.

## Example: full funding flow

\`\`\`bash
# 1. Get a quote
curl -X GET "http://localhost:3001/api/v2/quote?sourceAsset=XLM&amount=1000000&targetAddress=GABCDE...XYZ" \\
  -H "X-API-Key: your-key"

# 2. Prepare the transaction (sign in your wallet)
curl -X POST http://localhost:3001/api/v2/fund/prepare \\
  -H "X-API-Key: your-key" -H "Content-Type: application/json" \\
  -d '{"sourceAddress":"GABCD...","targetAddress":"CABCD...","tokenAddress":"CABCD...","amount":"1000000"}'

# 3. Submit the signed XDR
curl -X POST http://localhost:3001/api/v2/fund \\
  -H "X-API-Key: your-key" -H "Content-Type: application/json" \\
  -d '{"signedXdr":"AAAAAgAAAA..."}'

# 4. Poll for status
curl -X GET http://localhost:3001/api/v2/status/abc123...def \\
  -H "X-API-Key: your-key"
\`\`\`
    `.trim(),
    contact: { name: 'Bridge API', url: 'https://github.com/C-Address-Onboarding-Bridge' },
  },
  servers: [
    { url: 'http://localhost:3001', description: 'Local development' },
  ],
  tags: [
    { name: 'Health', description: 'Server health and readiness' },
    { name: 'Quote', description: 'Get fee quotes for funding transactions' },
    { name: 'Fund', description: 'Submit and prepare funding transactions' },
    { name: 'Status', description: 'Poll transaction status on Soroban' },
    { name: 'Offramp', description: 'Generate offramp widget URLs (MoonPay, Transak)' },
    { name: 'CEX', description: 'CEX withdrawal routing' },
    { name: 'API Keys', description: 'Manage API keys and permissions' },
  ],
});
