import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { STELLAR_ADDRESS_REGEX } from '../utils/constants';

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
  .regex(STELLAR_ADDRESS_REGEX)
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

/** Shorthand for an error response documented with the shared ErrorResponse schema. */
function errorResponse(description: string) {
  return { description, content: { 'application/json': { schema: ErrorResponse } } };
}

const Unauthorized = errorResponse('Missing or invalid API key');

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
    'Simulates the contract call and returns an unsigned transaction XDR for the client to sign. Sign this with your wallet and POST it to /api/v2/fund. No transaction is submitted and no metrics are recorded.',
  tags: ['Fund'],
  security: [{ ApiKeyAuth: ['fund:write'] }],
  request: { body: { content: { 'application/json': { schema: FundPrepareRequest } } } },
  responses: {
    200: {
      description: 'Unsigned transaction ready for signing',
      content: {
        'application/json': {
          schema: z.object({
            unsignedXdr: z.string().openapi({ description: 'Base64-encoded unsigned transaction XDR ready to sign' }),
            footprint: z.string().openapi({ description: 'Base64-encoded Soroban ledger footprint' }),
            fee: z.string().openapi({ description: 'Estimated fee in stroops' }),
            sourceAddress: StellarAddress,
            targetAddress: StellarAddress,
            tokenAddress: StellarAddress,
            amount: StroopsAmount,
            memo: z.string().optional(),
          }).openapi({ title: 'FundPrepareResponse' }),
        },
      },
    },
    400: { description: 'Validation or simulation error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

const BatchFundRequest = registry.register(
  'BatchFundRequest',
  z
    .object({
      signedXdr: z
        .string()
        .min(1)
        .openapi({ example: 'AAAAAgAAAABxy...', description: 'Base64-encoded signed batch_fund_c_address transaction XDR (max 65536 chars)' }),
      recipients: z
        .array(z.object({ target: StellarAddress, amount: StroopsAmount }))
        .min(1)
        .max(100)
        .openapi({ description: 'Must match the recipients encoded in signedXdr, in order' }),
    })
    .openapi({ title: 'BatchFundRequest' }),
);

registry.registerPath({
  method: 'post',
  path: '/api/v2/fund/batch',
  operationId: 'submitBatchFunding',
  summary: 'Submit a signed batch funding transaction',
  description:
    'Submits a pre-signed transaction that funds up to 100 C-addresses. The recipients in the body are cross-checked against those decoded from signedXdr. Funding bodies may be up to 128 KB.',
  tags: ['Fund'],
  security: [{ ApiKeyAuth: ['fund:write'] }],
  request: { body: { content: { 'application/json': { schema: BatchFundRequest } } } },
  responses: {
    201: {
      description: 'Batch transaction submitted',
      content: {
        'application/json': {
          schema: z
            .object({
              transactionHash: TxHash,
              status: z.enum(['pending', 'success', 'failed']),
              error: z.string().optional(),
              recipients: z.array(z.object({ target: StellarAddress, amount: StroopsAmount, status: z.string() })),
              explorerUrl: z.string().url().optional(),
              explorerUrls: z.array(z.string().url()).optional(),
            })
            .openapi({ title: 'BatchFundResponse' }),
        },
      },
    },
    400: errorResponse('Invalid XDR (e.g. XDR_TOO_LARGE), xdr_decode_failed, recipient_mismatch or validation error'),
    401: Unauthorized,
    413: errorResponse('Body exceeds the funding limit (XDR_TOO_LARGE)'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v2/fund/direct',
  operationId: 'submitDirectFunding',
  summary: 'Build, sign and submit a funding transaction server-side',
  description: 'Submits a funding transaction using the server-side signer for the given parameters.',
  tags: ['Fund'],
  security: [{ ApiKeyAuth: ['fund:write'] }],
  request: {
    body: {
      content: {
        'application/json': { schema: FundPrepareRequest.openapi({ title: 'FundDirectRequest' }) },
      },
    },
  },
  responses: {
    201: { description: 'Transaction submitted', content: { 'application/json': { schema: TxStatusResponse } } },
    400: errorResponse('Validation error'),
    401: Unauthorized,
  },
});

// ── #637: Timelocked funding — 501 Not Implemented ────────────────────────────
// The on-chain contract has no timelock support. These paths are documented
// so clients can anticipate the 501 response.

registry.registerPath({
  method: 'post',
  path: '/api/v2/fund/timelocked',
  operationId: 'createTimelockedFunding',
  summary: 'Create a timelocked funding transaction (not implemented)',
  description:
    'Timelocked funding requires on-chain contract support that has not yet been implemented. Always returns 501 Not Implemented.',
  tags: ['Fund'],
  security: [{ ApiKeyAuth: ['fund:write'] }],
  request: { body: { content: { 'application/json': { schema: z.object({}).openapi({ title: 'TimelockedFundRequest' }) } } } },
  responses: {
    501: { description: 'Not implemented — contract lacks timelock support', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v2/fund/timelocked/{id}',
  operationId: 'getTimelockedFunding',
  summary: 'Get timelocked funding status (not implemented)',
  description:
    'Timelocked funding status requires on-chain contract support that has not yet been implemented. Always returns 501 Not Implemented.',
  tags: ['Fund'],
  security: [{ ApiKeyAuth: ['fund:write'] }],
  request: { params: z.object({ id: z.string() }).openapi({ title: 'TimelockedFundParams' }) },
  responses: {
    501: { description: 'Not implemented — contract lacks timelock support', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v2/fund/timelocked/{id}/claim',
  operationId: 'claimTimelockedFunding',
  summary: 'Claim timelocked funds (not implemented)',
  description:
    'Claiming timelocked funds requires on-chain contract support that has not yet been implemented. Always returns 501 Not Implemented.',
  tags: ['Fund'],
  security: [{ ApiKeyAuth: ['fund:write'] }],
  request: { params: z.object({ id: z.string() }).openapi({ title: 'TimelockedClaimParams' }) },
  responses: {
    501: { description: 'Not implemented — contract lacks timelock support', content: { 'application/json': { schema: ErrorResponse } } },
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

registry.registerPath({
  method: 'get',
  path: '/api/v2/status/queues',
  operationId: 'getQueueStats',
  summary: 'Background queue statistics',
  description: 'Returns queue depth and processing statistics for the background job queues.',
  tags: ['Status'],
  security: [{ ApiKeyAuth: ['status:read'] }],
  responses: {
    200: {
      description: 'Queue statistics',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: z.record(z.unknown()) }).openapi({ title: 'QueueStatsResponse' }),
        },
      },
    },
    401: Unauthorized,
    500: errorResponse('Queue statistics unavailable'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v2/status/health',
  operationId: 'getStatusHealth',
  summary: 'Status router health probe',
  tags: ['Status'],
  security: [{ ApiKeyAuth: ['status:read'] }],
  responses: {
    200: {
      description: 'Status router is up',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: z.object({ status: z.literal('ok') }) }).openapi({ title: 'StatusHealthResponse' }),
        },
      },
    },
    401: Unauthorized,
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

const MoonpayQuoteQuery = registry.register(
  'MoonpayQuoteQuery',
  z
    .object({
      baseCurrency: z.string().openapi({ example: 'USD' }),
      baseCurrencyAmount: z.coerce.number().positive().openapi({ example: 100 }),
      quoteCurrency: z.string().default('xlm').openapi({ example: 'xlm' }),
    })
    .openapi({ title: 'MoonpayQuoteQuery' }),
);

const MoonpayQuoteResponse = registry.register(
  'MoonpayQuoteResponse',
  z
    .object({
      quoteCurrencyAmount: z.number(),
      feeAmount: z.number(),
      totalAmount: z.number(),
    })
    .openapi({ title: 'MoonpayQuoteResponse' }),
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
  method: 'get',
  path: '/api/v2/offramp/moonpay/quote',
  operationId: 'moonpayBuyQuote',
  summary: 'Fetch a real-time MoonPay buy quote',
  description: 'Returns quote, fee, and total amounts for converting a fiat base currency to a crypto quote currency via MoonPay.',
  tags: ['Offramp'],
  security: [{ ApiKeyAuth: ['offramp:write'] }],
  request: { query: MoonpayQuoteQuery },
  responses: {
    200: { description: 'Buy quote', content: { 'application/json': { schema: MoonpayQuoteResponse } } },
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

const OfframpQuoteQuery = registry.register(
  'OfframpQuoteQuery',
  z
    .object({
      fiatAmount: z.coerce.number().positive().openapi({ example: 100 }),
      fiatCurrency: z.string().min(1).openapi({ example: 'USD' }),
      cryptoCurrency: z.string().min(1).default('xlm').openapi({ example: 'xlm' }),
      cAddress: StellarAddress,
    })
    .openapi({ title: 'OfframpQuoteQuery' }),
);

const ProviderQuote = z
  .object({
    provider: z.enum(['moonpay', 'transak']),
    fiatAmount: z.number(),
    cryptoAmount: z.number(),
    feeAmount: z.number(),
    netAmount: z.number(),
    estimatedRate: z.number(),
  })
  .openapi({ title: 'ProviderQuote' });

registry.registerPath({
  method: 'get',
  path: '/api/v2/offramp/quote',
  operationId: 'compareOnrampQuotes',
  summary: 'Compare MoonPay and Transak quotes',
  description: 'Fetches quotes from every provider and returns them sorted by net amount, best first.',
  tags: ['Offramp'],
  security: [{ ApiKeyAuth: ['offramp:write'] }],
  request: { query: OfframpQuoteQuery },
  responses: {
    200: {
      description: 'Quotes sorted best first',
      content: {
        'application/json': {
          schema: z
            .object({
              best: ProviderQuote,
              alternatives: z.array(ProviderQuote),
              comparison: z.array(ProviderQuote),
              errors: z.array(z.object({ provider: z.string(), error: z.string() })).optional(),
            })
            .openapi({ title: 'OfframpQuoteResponse' }),
        },
      },
    },
    400: errorResponse('Validation error'),
    401: Unauthorized,
    503: errorResponse('No provider returned a quote'),
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

// ── Token ─────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/api/v2/token/{contractId}/metadata',
  operationId: 'getTokenMetadata',
  summary: 'Get token metadata',
  description: 'Returns decimals, name and symbol for a token contract. Use `native` for XLM.',
  tags: ['Token'],
  security: [{ ApiKeyAuth: ['quote:read'] }],
  request: {
    params: z.object({ contractId: z.string().openapi({ example: 'native' }) }).openapi({ title: 'TokenParams' }),
  },
  responses: {
    200: {
      description: 'Token metadata',
      content: {
        'application/json': {
          schema: z
            .object({
              success: z.literal(true),
              data: z.object({ decimals: z.number().int(), name: z.string(), symbol: z.string() }),
            })
            .openapi({ title: 'TokenMetadataResponse' }),
        },
      },
    },
    401: Unauthorized,
    500: errorResponse('Metadata lookup failed'),
  },
});

// ── Provider webhooks (inbound) ───────────────────────────────────────────────

const ProviderWebhookAck = z.object({ status: z.literal('ok') }).openapi({ title: 'ProviderWebhookAck' });

for (const provider of ['moonpay', 'transak'] as const) {
  registry.registerPath({
    method: 'post',
    path: `/api/webhook/${provider}`,
    operationId: `${provider}Webhook`,
    summary: `Receive a ${provider === 'moonpay' ? 'MoonPay' : 'Transak'} order webhook`,
    description:
      'Inbound callback from the provider. Authenticated by the provider HMAC signature header instead of an API key; replays are rejected.',
    tags: ['Provider Webhooks'],
    request: {
      body: {
        content: {
          'application/json': {
            schema: z
              .object({ data: z.object({ id: z.string(), status: z.string() }).passthrough() })
              .passthrough()
              .openapi({ title: 'ProviderWebhookPayload' }),
          },
        },
      },
    },
    responses: {
      200: { description: 'Webhook accepted', content: { 'application/json': { schema: ProviderWebhookAck } } },
      401: errorResponse('Missing or invalid signature, or replayed delivery'),
      500: errorResponse('Processing error'),
    },
  });
}

// ── Webhook administration ────────────────────────────────────────────────────

const WebhookRegisterRequest = registry.register(
  'WebhookRegisterRequest',
  z
    .object({
      url: z.string().url().openapi({ example: 'https://example.com/webhook' }),
      secret: z.string().min(16).openapi({ description: 'HMAC secret used to sign deliveries' }),
      events: z.array(z.string().min(1)).min(1).default(['*']).openapi({ example: ['funding.confirmed'] }),
    })
    .openapi({ title: 'WebhookRegisterRequest' }),
);

const WebhookRegistration = registry.register(
  'WebhookRegistration',
  z
    .object({ id: z.string(), url: z.string().url(), events: z.array(z.string()), createdAt: z.number() })
    .openapi({ title: 'WebhookRegistration' }),
);

const DeliveryAttempt = registry.register(
  'WebhookDeliveryAttempt',
  z
    .object({
      id: z.string(),
      registrationId: z.string(),
      webhookUrl: z.string().url(),
      event: z.string(),
      statusCode: z.number().int().optional(),
      error: z.string().optional(),
      timestamp: z.number(),
      attemptNumber: z.number().int(),
    })
    .openapi({ title: 'WebhookDeliveryAttempt' }),
);

const WebhookIdParam = z.object({ id: z.string() }).openapi({ title: 'WebhookIdParam' });
const DeletedResponse = z.object({ status: z.literal('deleted') }).openapi({ title: 'DeletedResponse' });

function webhookAdminPath(
  method: 'get' | 'post' | 'delete',
  path: string,
  operationId: string,
  summary: string,
  response: { description: string; schema: z.ZodTypeAny; status?: number },
  extra: { params?: z.AnyZodObject; body?: z.ZodTypeAny; notFound?: boolean } = {},
) {
  registry.registerPath({
    method,
    path: `/api/v1/webhooks${path}`,
    operationId,
    summary,
    tags: ['Webhooks'],
    security: [{ ApiKeyAuth: ['admin:keys'] }],
    request: {
      ...(extra.params ? { params: extra.params } : {}),
      ...(extra.body ? { body: { content: { 'application/json': { schema: extra.body } } } } : {}),
    },
    responses: {
      [response.status ?? 200]: { description: response.description, content: { 'application/json': { schema: response.schema } } },
      ...(extra.body ? { 400: errorResponse('Validation error') } : {}),
      401: Unauthorized,
      ...(extra.notFound ? { 404: errorResponse('Not found or owned by another key') } : {}),
    },
  });
}

webhookAdminPath('post', '/register', 'registerWebhook', 'Register a webhook callback URL', {
  status: 201,
  description: 'Webhook registered',
  schema: WebhookRegistration,
}, { body: WebhookRegisterRequest });

webhookAdminPath('get', '/registrations', 'listWebhooks', "List the calling key's webhook registrations", {
  description: 'Registrations',
  schema: z.object({ registrations: z.array(WebhookRegistration) }).openapi({ title: 'WebhookRegistrationList' }),
});

webhookAdminPath('delete', '/registrations/{id}', 'deleteWebhook', 'Delete a webhook registration', {
  description: 'Registration deleted',
  schema: DeletedResponse,
}, { params: WebhookIdParam, notFound: true });

webhookAdminPath('get', '/dlq', 'listWebhookDlq', 'List failed deliveries in the dead letter queue', {
  description: 'DLQ entries',
  schema: z
    .object({
      entries: z.array(
        z.object({
          id: z.string(),
          registrationId: z.string(),
          url: z.string().url(),
          event: z.string(),
          failedAt: z.number(),
          attemptCount: z.number().int(),
        }),
      ),
    })
    .openapi({ title: 'WebhookDlqList' }),
});

webhookAdminPath('get', '/dlq/{id}', 'getWebhookDlqEntry', 'Get a DLQ entry with payload and attempt history', {
  description: 'DLQ entry',
  schema: z
    .object({
      id: z.string(),
      registration: z.object({ id: z.string(), url: z.string().url(), events: z.array(z.string()), createdAt: z.number() }),
      payload: z.unknown(),
      event: z.string(),
      attempts: z.array(DeliveryAttempt),
      failedAt: z.number(),
    })
    .openapi({ title: 'WebhookDlqEntry' }),
}, { params: WebhookIdParam, notFound: true });

webhookAdminPath('delete', '/dlq/{id}', 'deleteWebhookDlqEntry', 'Remove a DLQ entry after resolution', {
  description: 'Entry deleted',
  schema: DeletedResponse,
}, { params: WebhookIdParam, notFound: true });

webhookAdminPath('get', '/stats', 'getWebhookStats', 'Webhook delivery statistics', {
  description: 'Statistics',
  schema: z
    .object({ registered: z.number().int(), dlqSize: z.number().int(), totalAttempts: z.number().int() })
    .openapi({ title: 'WebhookStats' }),
});

webhookAdminPath('get', '/log', 'getWebhookDeliveryLog', "Delivery attempts for the calling key's webhooks", {
  description: 'Delivery log',
  schema: z.object({ attempts: z.array(DeliveryAttempt) }).openapi({ title: 'WebhookDeliveryLog' }),
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

const ApiKeyRecord = registry.register(
  'ApiKeyRecord',
  z
    .object({
      id: z.string(),
      name: z.string(),
      createdBy: z.string(),
      createdAt: z.number(),
      updatedAt: z.number(),
      lastUsedAt: z.number().nullable(),
      scopes: z.array(z.string()),
      ipWhitelist: z.array(z.string()),
      expiresAt: z.number().nullable(),
      rateLimit: z.enum(['low', 'standard', 'high']),
      revoked: z.boolean(),
    })
    .openapi({ title: 'ApiKeyRecord' }),
);

registry.registerPath({
  method: 'get',
  path: '/api/v1/keys/audit',
  operationId: 'getApiKeyAuditLog',
  summary: 'API key usage audit log',
  tags: ['API Keys'],
  security: [{ ApiKeyAuth: ['admin:keys'] }],
  request: {
    query: z
      .object({
        offset: z.coerce.number().int().min(0).default(0).optional(),
        limit: z.coerce.number().int().positive().default(100).optional(),
      })
      .openapi({ title: 'ApiKeyAuditQuery' }),
  },
  responses: {
    200: {
      description: 'Audit entries',
      content: {
        'application/json': {
          schema: z
            .object({
              entries: z.array(
                z.object({ ts: z.number(), keyId: z.string(), ip: z.string(), path: z.string(), method: z.string() }),
              ),
              total: z.number().int(),
              offset: z.number().int(),
              limit: z.number().int(),
            })
            .openapi({ title: 'ApiKeyAuditResponse' }),
        },
      },
    },
    401: Unauthorized,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/keys/{id}',
  operationId: 'getApiKey',
  summary: 'Get an API key record',
  tags: ['API Keys'],
  security: [{ ApiKeyAuth: ['admin:keys'] }],
  request: { params: z.object({ id: z.string() }).openapi({ title: 'GetKeyParams' }) },
  responses: {
    200: { description: 'API key record', content: { 'application/json': { schema: ApiKeyRecord } } },
    401: Unauthorized,
    404: errorResponse('Key not found'),
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/keys/{id}',
  operationId: 'updateApiKey',
  summary: 'Update an API key',
  tags: ['API Keys'],
  security: [{ ApiKeyAuth: ['admin:keys'] }],
  request: {
    params: z.object({ id: z.string() }).openapi({ title: 'UpdateKeyParams' }),
    body: {
      content: {
        'application/json': {
          schema: z
            .object({
              name: z.string().min(1),
              scopes: CreateKeyRequest.shape.scopes,
              ipWhitelist: z.array(z.string()),
              expiresAt: z.number().nullable(),
              rateLimit: z.enum(['low', 'standard', 'high']),
            })
            .partial()
            .openapi({ title: 'UpdateKeyRequest' }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Key updated',
      content: { 'application/json': { schema: z.object({ status: z.literal('updated') }).openapi({ title: 'UpdateKeyResponse' }) } },
    },
    400: errorResponse('Validation error'),
    401: Unauthorized,
    404: errorResponse('Key not found'),
  },
});

// ── Transactions ──────────────────────────────────────────────────────────────

const TransactionRecord = registry.register(
  'TransactionRecord',
  z
    .object({
      id: z.string(),
      txHash: z.string(),
      sourceAddr: z.string(),
      targetAddr: z.string(),
      status: z.enum(['pending', 'success', 'failed']),
      amount: z.string(),
      fee: z.string(),
      createdAt: z.string(),
      currency: z.string(),
    })
    .openapi({ title: 'TransactionRecord' }),
);

registry.registerPath({
  method: 'get',
  path: '/api/v1/transactions',
  operationId: 'listTransactions',
  summary: 'Transaction history',
  description: 'Lists transactions with filtering and cursor pagination. Pass `format=csv` for a CSV export (not cached).',
  tags: ['Transactions'],
  security: [{ ApiKeyAuth: ['transactions:read'] }],
  request: {
    query: z
      .object({
        status: z.enum(['pending', 'success', 'failed']).optional(),
        fromDate: z.string().optional().openapi({ example: '2026-01-01T00:00:00Z' }),
        toDate: z.string().optional(),
        minAmount: z.string().optional(),
        maxAmount: z.string().optional(),
        limit: z.coerce.number().int().positive().optional(),
        offset: z.coerce.number().int().min(0).optional(),
        cursor: z.string().optional(),
        format: z.enum(['json', 'csv']).default('json').optional(),
      })
      .openapi({ title: 'TransactionQuery' }),
  },
  responses: {
    200: {
      description: 'Transactions (JSON) or CSV export',
      content: {
        'application/json': {
          schema: z
            .object({ data: z.array(TransactionRecord), nextCursor: z.string().nullable(), hasMore: z.boolean() })
            .openapi({ title: 'TransactionListResponse' }),
        },
        'text/csv': { schema: z.string() },
      },
    },
    401: Unauthorized,
  },
});

// ── Admin ─────────────────────────────────────────────────────────────────────

function adminPath(
  method: 'get' | 'post',
  path: string,
  operationId: string,
  summary: string,
  responses: Record<number, { description: string; content?: Record<string, { schema: z.ZodTypeAny }> }>,
  request: { query?: z.AnyZodObject; body?: z.ZodTypeAny } = {},
) {
  registry.registerPath({
    method,
    path: `/api/v1/admin${path}`,
    operationId,
    summary,
    tags: ['Admin'],
    security: [{ ApiKeyAuth: ['admin:keys'] }],
    request: {
      ...(request.query ? { query: request.query } : {}),
      ...(request.body ? { body: { content: { 'application/json': { schema: request.body } } } } : {}),
    },
    responses: { ...responses, 401: Unauthorized },
  });
}

const json = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });

const AuditCheckpoint = registry.register(
  'AuditCheckpoint',
  z
    .object({
      sequence: z.number().int(),
      hash: z.string(),
      timestamp: z.number(),
      publisher: z.enum(['local', 'trusted-timestamp']),
      publicationRef: z.string(),
    })
    .openapi({ title: 'AuditCheckpoint' }),
);

const AuditLogEntry = registry.register(
  'AuditLogEntry',
  z
    .object({
      sequence: z.number().int(),
      id: z.string(),
      timestamp: z.number(),
      type: z.string(),
      actor: z.string(),
      payload: z.record(z.unknown()),
      previousHash: z.string(),
      hash: z.string(),
      retentionUntil: z.number(),
    })
    .openapi({ title: 'AuditLogEntry' }),
);

const AuditVerification = registry.register(
  'AuditVerification',
  z
    .object({
      valid: z.boolean(),
      entryCount: z.number().int(),
      checkpointCount: z.number().int(),
      errors: z.array(z.object({ sequence: z.number().int().optional(), message: z.string() })),
    })
    .openapi({ title: 'AuditVerification' }),
);

const FeeConfig = z
  .object({
    feeBps: z.number().int(),
    updatedAt: z.number(),
    pendingFeeBps: z.number().int().nullable(),
    timelockUntil: z.number().nullable(),
  })
  .openapi({ title: 'FeeConfig' });

adminPath('get', '/stats', 'getAdminStats', 'Transaction statistics', {
  200: {
    description: 'Counts by status',
    content: json(
      z
        .object({
          total: z.number().int(),
          byStatus: z.object({ pending: z.number().int(), success: z.number().int(), failed: z.number().int() }),
        })
        .openapi({ title: 'AdminStats' }),
    ),
  },
});

adminPath('get', '/fees', 'getFeeConfig', 'Current fee configuration', {
  200: { description: 'Fee configuration', content: json(FeeConfig) },
});

adminPath('post', '/fees', 'updateFeeConfig', 'Propose a new fee rate (timelocked)', {
  200: {
    description: 'Fee change scheduled',
    content: json(z.object({ pendingFeeBps: z.number().int(), timelockUntil: z.number() }).openapi({ title: 'FeeUpdateResponse' })),
  },
  400: errorResponse('feeBps outside [0, 1000] or invalid timelockMs'),
}, {
  body: z
    .object({
      feeBps: z.number().int().min(0).max(1000).openapi({ example: 30 }),
      timelockMs: z.number().int().min(0).default(60000).optional(),
    })
    .openapi({ title: 'FeeUpdateRequest' }),
});

adminPath('post', '/fees/withdraw', 'withdrawFees', 'Create a governance proposal to withdraw accumulated fees', {
  200: {
    description: 'Withdrawal proposal created',
    content: json(
      z
        .object({
          proposalId: z.string(),
          status: z.literal('proposal_created'),
          recipient: z.string(),
          token: z.string(),
          note: z.string(),
        })
        .openapi({ title: 'FeeWithdrawResponse' }),
    ),
  },
}, {
  body: z
    .object({ recipientAddress: StellarAddress.optional(), tokenAddress: StellarAddress.optional() })
    .openapi({ title: 'FeeWithdrawRequest' }),
});

adminPath('get', '/health', 'getAdminHealth', 'Detailed health including circuit breakers and cache', {
  200: { description: 'Healthy or degraded', content: json(z.record(z.unknown()).openapi({ title: 'AdminHealth' })) },
  503: { description: 'Unhealthy', content: json(z.record(z.unknown())) },
});

adminPath('get', '/audit', 'getAdminAuditLog', 'Admin action log', {
  200: {
    description: 'Admin actions',
    content: json(
      z
        .object({
          log: z.array(z.object({ ts: z.number(), action: z.string(), actor: z.string(), details: z.record(z.unknown()) })),
        })
        .openapi({ title: 'AdminAuditLog' }),
    ),
  },
});

adminPath('get', '/audit/integrity', 'listIntegrityAuditEntries', 'Hash-chained audit log entries', {
  200: { description: 'Entries', content: json(z.object({ entries: z.array(AuditLogEntry) }).openapi({ title: 'AuditEntryList' })) },
}, {
  query: z
    .object({
      type: z.string().optional(),
      limit: z.coerce.number().int().positive().optional(),
      cursor: z.coerce.number().int().optional(),
    })
    .openapi({ title: 'AuditEntryQuery' }),
});

adminPath('get', '/audit/integrity/checkpoints', 'listAuditCheckpoints', 'List audit checkpoints', {
  200: {
    description: 'Checkpoints',
    content: json(z.object({ checkpoints: z.array(AuditCheckpoint) }).openapi({ title: 'AuditCheckpointList' })),
  },
});

adminPath('post', '/audit/integrity/checkpoints', 'createAuditCheckpoint', 'Publish a checkpoint for the latest entry', {
  201: { description: 'Checkpoint created', content: json(AuditCheckpoint) },
  404: errorResponse('No audit entries to checkpoint'),
});

adminPath('get', '/audit/integrity/verify', 'verifyAuditLog', 'Verify the audit hash chain', {
  200: { description: 'Chain is valid', content: json(AuditVerification) },
  409: { description: 'Chain is broken', content: json(AuditVerification) },
});

adminPath('get', '/audit/integrity/export', 'exportAuditLog', 'Export the audit log as JSON or NDJSON', {
  200: {
    description: 'Audit export',
    content: {
      'application/json': {
        schema: z
          .object({
            format: z.literal('c-address-bridge.audit.v1'),
            exportedAt: z.number(),
            retentionPolicy: z.string(),
            entries: z.array(AuditLogEntry),
            checkpoints: z.array(AuditCheckpoint),
            verification: AuditVerification,
          })
          .openapi({ title: 'AuditExport' }),
      },
      'application/x-ndjson': { schema: z.string() },
    },
  },
}, { query: z.object({ format: z.enum(['json', 'ndjson']).default('json').optional() }).openapi({ title: 'AuditExportQuery' }) });

// ── Observability ─────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/api/v1/cache/metrics',
  operationId: 'getCacheMetrics',
  summary: 'Cache hit/miss statistics',
  tags: ['Observability'],
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      description: 'Cache metrics',
      content: json(
        z
          .object({
            redisEnabled: z.boolean(),
            hits: z.number().int(),
            misses: z.number().int(),
            hitRatio: z.number(),
            entryCount: z.number().int(),
            memoryBytes: z.number().int(),
          })
          .openapi({ title: 'CacheMetrics' }),
      ),
    },
    401: Unauthorized,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/metrics',
  operationId: 'getPrometheusMetrics',
  summary: 'Prometheus metrics',
  tags: ['Observability'],
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: { description: 'Prometheus text exposition format', content: { 'text/plain': { schema: z.string() } } },
    401: Unauthorized,
    500: errorResponse('Metrics unavailable'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/telemetry/telemetry',
  operationId: 'submitTelemetry',
  summary: 'Submit SDK telemetry',
  description: 'Anonymous SDK usage telemetry. No API key required; rate limited per IP.',
  tags: ['Observability'],
  request: {
    body: {
      content: json(
        z
          .object({
            sdkVersion: z.string().min(1),
            nodeVersion: z.string().min(1),
            platform: z.string().min(1),
            method: z.string().min(1),
            responseTimeMs: z.number().int().nonnegative(),
            errorType: z.string().optional(),
          })
          .openapi({ title: 'TelemetryEvent' }),
      ),
    },
  },
  responses: {
    202: { description: 'Accepted', content: json(z.object({ accepted: z.literal(true) }).openapi({ title: 'TelemetryAck' })) },
    400: errorResponse('Validation error'),
    429: errorResponse('Rate limit exceeded'),
  },
});

// ── Docs ──────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/api/openapi.json',
  operationId: 'getOpenApiSpec',
  summary: 'This OpenAPI document',
  tags: ['Docs'],
  responses: { 200: { description: 'OpenAPI 3.1 document', content: json(z.record(z.unknown())) } },
});

registry.registerPath({
  method: 'get',
  path: '/api/docs',
  operationId: 'getSwaggerUi',
  summary: 'Interactive Swagger UI',
  tags: ['Docs'],
  responses: { 200: { description: 'Swagger UI page', content: { 'text/html': { schema: z.string() } } } },
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

registry.registerPath({
  method: 'get',
  path: '/health/ready',
  operationId: 'healthReady',
  summary: 'Readiness probe',
  description: 'Fails when a critical dependency is down or the server is shutting down.',
  tags: ['Health'],
  responses: {
    200: {
      description: 'Ready',
      content: json(
        z.object({ ready: z.boolean(), status: z.string().optional(), reason: z.string().optional() }).openapi({ title: 'ReadinessResponse' }),
      ),
    },
    503: { description: 'Not ready', content: json(z.object({ ready: z.literal(false), status: z.string().optional(), reason: z.string().optional() })) },
  },
});

registry.registerPath({
  method: 'get',
  path: '/health/live',
  operationId: 'healthLive',
  summary: 'Liveness probe',
  tags: ['Health'],
  responses: {
    200: {
      description: 'Process is alive',
      content: json(z.object({ alive: z.literal(true), timestamp: z.number() }).openapi({ title: 'LivenessResponse' })),
    },
  },
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/ws',
  operationId: 'statusWebSocket',
  summary: 'Live transaction status over WebSocket',
  description: [
    'Upgrade to a WebSocket, passing the API key as the `Sec-WebSocket-Protocol` header.',
    'Client messages: `{"action":"subscribe","txHash":"...","lastKnownStatus":"pending"}`,',
    '`{"action":"unsubscribe","txHash":"..."}` and `{"action":"list"}`.',
    'Server messages have a `type` of `connected`, `subscribed`, `unsubscribed`, `subscriptions`, `status_update`, `subscription_closed` or `error`.',
  ].join(' '),
  tags: ['WebSocket'],
  request: {
    headers: z
      .object({
        'sec-websocket-protocol': z.string().openapi({ description: 'API key' }),
      })
      .openapi({ title: 'WebSocketHeaders' }),
  },
  responses: {
    101: { description: 'Switching protocols' },
    401: { description: 'Missing, invalid, revoked or expired key' },
    429: { description: 'Too many connections for this key or IP' },
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
    { name: 'Token', description: 'Token metadata' },
    { name: 'Transactions', description: 'Transaction history and CSV export' },
    { name: 'Webhooks', description: 'Manage outgoing webhook registrations and the dead letter queue' },
    { name: 'Provider Webhooks', description: 'Inbound MoonPay and Transak callbacks (HMAC-signed)' },
    { name: 'Admin', description: 'Fees, statistics and the integrity audit log' },
    { name: 'Observability', description: 'Cache metrics, Prometheus metrics and SDK telemetry' },
    { name: 'Docs', description: 'OpenAPI document and Swagger UI' },
    { name: 'WebSocket', description: 'Live transaction status push' },
  ],
});
