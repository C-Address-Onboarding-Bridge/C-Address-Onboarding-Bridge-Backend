# SDK

## TypeScript compatibility

The SDK is published with strict TypeScript compatibility in mind. Consumers can enable `strict` in their tsconfig without additional work.

## Telemetry

The SDK can emit anonymous usage telemetry when enabled. Telemetry is opt-out and can be disabled by setting `SDK_TELEMETRY_ENABLED=false`.

The payload includes only non-PII metadata such as SDK version, Node.js version, platform, invoked method, response time, and error type. No API keys, addresses, or transaction data are collected.

## Browser usage

The SDK ships with an ESM build for bundlers and a UMD bundle for browser script tags. Browser usage requires a global `fetch` implementation in the target environment.

## Quickstart

```ts
import { BridgeClient } from '@c-address-bridge/sdk';

const client = new BridgeClient({
  baseUrl: 'https://api.bridge.example.com',
  apiKey: 'your-api-key',
});

// 1. Get a fee quote for funding a C-address
const quote = await client.getQuote({
  sourceAsset: 'XLM',
  amount: '10000000',        // 1 XLM in stroops
  targetAddress: 'C...',
});

// 2. Prepare an unsigned funding transaction
const prepared = await client.prepareFundingTransaction({
  sourceAddress: 'G...',
  targetAddress: 'C...',
  tokenAddress: 'CC...',     // SEP-41 token contract address
  amount: '10000000',
});

// 3. Sign prepared.instruction with the user's wallet, then submit it
const result = await client.submitSignedXdr({ signedXdr: '...' });

console.log(result.status); // 'pending' | 'success' | 'failed'
```

See the [Wallet Integration Guide](../docs/wallet-integration.md) for the full funding flows (G-address, CEX withdrawal, credit card on-ramp) and typed error handling.

## Testing

The SDK ships with a dedicated testing package at `@c-address-bridge/sdk/testing`. It provides an in-memory mock server that intercepts `fetch` — no real API server or network required.

### Quick start

```ts
import { createMockServer, fixtures, MOCK_C_ADDRESS, MOCK_TX_HASH } from '@c-address-bridge/sdk/testing';
import { BridgeClient } from '@c-address-bridge/sdk';

const mock = createMockServer();

beforeEach(() => mock.install());
afterEach(() => { mock.reset(); mock.uninstall(); });

it('fetches a quote', async () => {
  const client = new BridgeClient({ baseUrl: 'http://mock' });
  const quote = await client.getQuote({ sourceAsset: 'XLM', amount: '1000', targetAddress: MOCK_C_ADDRESS });
  expect(quote.feeBps).toBe(100); // default fixture value
});
```

The mock server returns **realistic fixture responses by default** — you can write tests without any setup.

### Overriding responses

```ts
// Custom response for a specific endpoint
mock.onQuote().reply(200, fixtures.quote({ rate: '2.5', feeBps: 50 }));

// Error response
mock.onQuote().replyError(503, 'Service temporarily unavailable');

// Override status for a specific transaction hash
mock.onStatus(MOCK_TX_HASH).reply(200, fixtures.transactionStatus('success'));

// Override status for any hash
mock.onStatus().reply(200, fixtures.transactionStatus('failed'));

// Generic route override (useful for paginated endpoints)
mock.onRoute('GET', '/api/v1/txns').reply(200, {
  data: [{ id: 'tx1' }],
  nextCursor: null,
  hasMore: false,
});
```

### Testing error handling

```ts
// Simulate a network-level failure (triggers SDK retry logic)
mock.onFund().networkError();

// Simulate a timeout (request hangs — combine with a short SDK timeout)
mock.onQuote().timeout();
const client = new BridgeClient({
  baseUrl: 'http://mock',
  retry: { maxRetries: 0, retryBudgetMs: 500 },
});
await expect(client.getQuote(params)).rejects.toThrow();
```

### Testing loading states (delays)

```ts
mock.onStatus(MOCK_TX_HASH).delay(200).reply(200, fixtures.transactionStatus('pending'));
```

### Asserting what the SDK sent

The mock server records every intercepted request for inspection:

```ts
await client.getQuote({ sourceAsset: 'USDC', amount: '5000', targetAddress: MOCK_C_ADDRESS });

const req = mock.requests[0];
expect(req.method).toBe('GET');
expect(req.pathname).toBe('/api/v1/quote');
expect(req.searchParams['sourceAsset']).toBe('USDC');
expect(req.headers['x-api-key']).toBe('my-api-key');
```

### Available fixtures

| Factory | Returns |
|---|---|
| `fixtures.quote(overrides?)` | `Quote` |
| `fixtures.fundingResult(overrides?)` | `FundingResult` |
| `fixtures.transactionStatus(status?, overrides?)` | `TransactionStatus` |
| `fixtures.fundingPrepareResult(overrides?)` | `FundingPrepareResult` |
| `fixtures.cexWithdrawalResult(overrides?)` | `CexWithdrawalResult` |
| `fixtures.moonpayWidgetResult(overrides?)` | `MoonpayWidgetResult` |
| `fixtures.transakWidgetResult(overrides?)` | `TransakWidgetResult` |
| `fixtures.apiError(message, code?)` | `{ message, code? }` |
| `fixtures.token(overrides?)` | `Token` |
| `fixtures.tokenMetadata(overrides?)` | `TokenMetadata` |

Pre-built constants: `MOCK_C_ADDRESS`, `MOCK_G_ADDRESS`, `MOCK_TOKEN_ADDRESS`, `MOCK_TX_HASH`, `MOCK_QUOTE_PARAMS`, `MOCK_FUND_PARAMS`, `MOCK_NATIVE_TOKEN`, `MOCK_SAC_TOKEN`, `MOCK_TOKEN_METADATA`.
