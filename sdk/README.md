# @c-address-bridge/sdk

TypeScript SDK for the C-Address Onboarding Bridge API.

## TypeScript compatibility

The SDK is published with strict TypeScript compatibility in mind. Consumers can enable `strict` in their `tsconfig` without additional work.

## Installation

```bash
npm install @c-address-bridge/sdk
```

## Quickstart

```ts
import { BridgeClient } from '@c-address-bridge/sdk';

const client = new BridgeClient({
  baseUrl: 'https://api.bridge.example.com',
  apiKey: 'your-api-key',
});

// 1. Get a fee quote
const quote = await client.getQuote({
  sourceAsset: 'XLM',
  amount: '10000000',      // 1 XLM in stroops
  targetAddress: 'C...',
});

// 2. Prepare an unsigned funding transaction
const prepared = await client.prepareFundingTransaction({
  sourceAddress: 'G...',
  targetAddress: 'C...',
  tokenAddress: 'CC...',
  amount: '10000000',
});
// prepared.unsignedXdr — sign this with the user's wallet

// 3. Submit the signed XDR
const result = await client.submitSignedXdr({ signedXdr: '<signed-base64-xdr>' });
console.log(result.status); // 'pending' | 'success' | 'failed'

client.destroy(); // stop background timers when done
```

See the [Wallet Integration Guide](../docs/wallet-integration.md) for the full funding flows and typed error handling.

## Configuration — `BridgeClientConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string` | — | Bridge API base URL (trailing slash stripped automatically) |
| `apiKey` | `string` | — | Sent as `X-API-Key` on every request |
| `locale` | `SupportedLocale` | `'en'` | Locale for SDK-thrown error messages |
| `signing.enabled` | `boolean` | `false` | Enable HMAC-SHA256 request signing |
| `signing.clockSkewToleranceMs` | `number` | `300_000` | Tolerance for clock drift when signing |
| `retry.maxRetries` | `number` | `3` | Maximum number of retry attempts |
| `retry.baseDelayMs` | `number` | `200` | Initial backoff delay in ms |
| `retry.maxDelayMs` | `number` | `10_000` | Maximum backoff delay in ms |
| `retry.retryBudgetMs` | `number` | `30_000` | Total time budget across all retries |
| `retry.jitterMs` | `number` | `100` | Random jitter added to each delay |
| `cache.quoteTtlMs` | `number` | `30_000` | TTL for cached quote responses |
| `cache.statusTtlMs` | `number` | `30_000` | TTL for cached status responses |
| `cache.healthTtlMs` | `number` | `30_000` | TTL for cached health responses |
| `cache.staleWhileRevalidate` | `boolean` | `false` | Serve stale cache entries while revalidating in the background |
| `cache.maxEntries` | `number` | `100` | Maximum number of cache entries |
| `telemetry.enabled` | `boolean` | `false` | Emit anonymous usage telemetry |
| `telemetry.endpoint` | `string` | — | URL to POST telemetry batches to |
| `telemetry.intervalMs` | `number` | `60_000` | How often to flush the telemetry buffer |

```ts
import { BridgeClient } from '@c-address-bridge/sdk';

const client = new BridgeClient({
  baseUrl: 'https://api.bridge.example.com',
  apiKey: 'my-key',
  locale: 'es',
  signing: { enabled: true },
  retry: { maxRetries: 5, baseDelayMs: 300 },
  cache: { quoteTtlMs: 60_000, staleWhileRevalidate: true },
  telemetry: { enabled: true, endpoint: 'https://telemetry.example.com/ingest' },
});
```

## Pagination

Large result sets are served as cursor-paginated pages. Use `PaginationHelper` to work with individual pages, or the `paginateAll` / `collectAllPages` helpers to consume every page automatically.

```ts
import { PaginationHelper, paginateAll, collectAllPages } from '@c-address-bridge/sdk';

// Manual page-by-page iteration
const helper = new PaginationHelper(
  (params) => client.listTransactions(params),
  { pageSize: 50 },
);

for await (const page of helper.pages()) {
  console.log(page.data);          // current page items
  console.log(page.nextCursor);    // cursor to fetch the next page
}

// Collect all items across all pages in one call
const allTxns = await collectAllPages(
  (params) => client.listTransactions(params),
  { pageSize: 100, throttleMs: 200 },
);
```

## Events

`BridgeEventEmitter` lets you react to transaction-status changes and connectivity events without polling manually.

```ts
import { BridgeEventEmitter } from '@c-address-bridge/sdk';

const emitter = new BridgeEventEmitter(
  (txHash) => client.getStatus(txHash),
  () => client.getHealth().then((h) => h.status !== 'unhealthy'),
  { pollIntervalMs: 3_000, historySize: 50 },
);

// Listen for status transitions on a specific transaction
emitter.on('status_change', (event) => {
  console.log(event.txHash, event.status);
});

// Watch a transaction (starts polling)
emitter.watch('abc123...64hexchars');

// Listen for connectivity events
emitter.on('online',  () => console.log('API is reachable'));
emitter.on('offline', () => console.log('API is unreachable'));

// Stop watching and clean up timers
emitter.unwatch('abc123...64hexchars');
emitter.destroy();
```

## Offline queue

`OfflineBridgeClient` wraps a `BridgeClient` with a durable offline queue. Requests made while the API is unreachable are stored locally and replayed automatically when the connection is restored.

```ts
import { OfflineBridgeClient } from '@c-address-bridge/sdk';

const client = new OfflineBridgeClient({
  baseUrl: 'https://api.bridge.example.com',
  apiKey: 'my-key',
}, {
  maxSize: 100,
  maxRetries: 3,
  healthCheckIntervalMs: 5_000,
  // Persist queue across page reloads (browser):
  storageAdapter: {
    getItem: (k) => localStorage.getItem(k),
    setItem: (k, v) => localStorage.setItem(k, v),
    removeItem: (k) => localStorage.removeItem(k),
  },
});

// Use exactly like BridgeClient — requests are queued when offline
const result = await client.submitSignedXdr({ signedXdr: '...' });

// Listen for drain events (queue flushed after reconnect)
client.queue.onDrain((count, at) => console.log(`Replayed ${count} requests at ${at}`));

client.destroy();
```

## Typed errors and guards

All SDK errors extend `BridgeError`. Use the `is*Error` guards or `instanceof` to branch by error type.

```ts
import {
  BridgeError,
  AuthError,
  ValidationError,
  RateLimitError,
  ServerError,
  NotFoundError,
  NetworkError,
  TimeoutError,
  OfflineError,
  QueueFullError,
  isAuthError,
  isValidationError,
  isRateLimitError,
  isServerError,
  isNetworkError,
  isTimeoutError,
  isNotFoundError,
  isBridgeError,
} from '@c-address-bridge/sdk';

try {
  await client.getQuote(params);
} catch (err) {
  if (isRateLimitError(err)) {
    // err.retryable === true
    console.log('Rate limited — back off and retry');
  } else if (isAuthError(err)) {
    console.log('Check your API key');
  } else if (isNetworkError(err)) {
    console.log('Network unavailable');
  } else if (isBridgeError(err)) {
    console.log(err.statusCode, err.code, err.message);
  }
}
```

| Guard | Error class | HTTP status |
|---|---|---|
| `isAuthError` | `AuthError` | 401, 403 |
| `isValidationError` | `ValidationError` | 400, 422 |
| `isRateLimitError` | `RateLimitError` | 429 |
| `isServerError` | `ServerError` | 5xx |
| `isNotFoundError` | `NotFoundError` | 404 |
| `isNetworkError` | `NetworkError` | — |
| `isTimeoutError` | `TimeoutError` | — |
| `isBridgeError` | `BridgeError` (base) | any |

## Locales

Error messages are localized. Pass `locale` in the config to change the language.

```ts
import { SUPPORTED_LOCALES } from '@c-address-bridge/sdk';

console.log(SUPPORTED_LOCALES); // ['en', 'es', 'fr', ...]

const client = new BridgeClient({ baseUrl, locale: 'es' });
// SDK-thrown errors now carry Spanish messages
```

## Utility methods

These methods are exported directly from the client:

| Method | Description |
|---|---|
| `client.runDiagnostics()` | Returns a structured health report for every configured dependency |
| `client.getTokenMetadata(params)` | Fetches metadata (decimals, name, symbol, issuer) for a SEP-41 token contract |
| `client.createMoonpayUrl(params)` | Generates a MoonPay widget URL for on-ramping to a C-address |
| `client.createTransakUrl(params)` | Generates a Transak widget URL for on-ramping to a C-address |
| `client.routeCexWithdrawal(params)` | Routes a CEX withdrawal (Binance, Coinbase, Kraken, generic) to a C-address |

## Subpath exports

The package exposes dedicated subpath exports for tree-shaking and direct imports:

| Import path | Exports |
|---|---|
| `@c-address-bridge/sdk` | Full public API |
| `@c-address-bridge/sdk/errors` | Error classes and guards only |
| `@c-address-bridge/sdk/offline` | `OfflineQueue`, `OfflineBridgeClient` |
| `@c-address-bridge/sdk/events` | `BridgeEventEmitter` |
| `@c-address-bridge/sdk/pagination` | `PaginationHelper`, `paginateAll`, `collectAllPages` |
| `@c-address-bridge/sdk/testing` | In-process mock server for unit tests |

## Telemetry

The SDK can emit anonymous usage telemetry when enabled. It is opt-out and can also be disabled with `SDK_TELEMETRY_ENABLED=false`.

The payload includes only non-PII metadata: SDK version, Node.js version, platform, invoked method, response time, and error type. No API keys, addresses, or transaction data are collected.

## Lifecycle and cleanup

Every client owns background timers (telemetry flushing, offline health poll). Call `destroy()` when you are done:

```ts
client.destroy(); // stops timers and flushes pending telemetry
```

In Node.js every interval is `unref()`'d so a forgotten `destroy()` will not keep the process alive. Browsers have no `unref`, so `destroy()` is required there. `destroy()` is idempotent; `OfflineBridgeClient.destroy()` also stops the queue's health poll.

## Browser usage

The SDK ships an ESM build for bundlers and a UMD bundle for `<script>` tags. Browser usage requires a global `fetch` implementation.

## Testing

The SDK ships a dedicated testing package at `@c-address-bridge/sdk/testing`. It provides an in-memory mock server that intercepts `fetch` — no real API or network required.

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
  expect(quote.feeBps).toBe(100);
});
```

### Overriding responses

```ts
mock.onQuote().reply(200, fixtures.quote({ rate: '2.5', feeBps: 50 }));
mock.onQuote().replyError(503, 'Service temporarily unavailable');
mock.onStatus(MOCK_TX_HASH).reply(200, fixtures.transactionStatus('success'));
mock.onStatus().reply(200, fixtures.transactionStatus('failed'));

// Generic route override (useful for paginated endpoints)
mock.onRoute('GET', '/api/v1/transactions').reply(200, {
  data: [{ id: 'tx1' }],
  nextCursor: null,
  hasMore: false,
});
```

### Simulating errors and delays

```ts
mock.onFund().networkError();
mock.onQuote().timeout();
mock.onStatus(MOCK_TX_HASH).delay(200).reply(200, fixtures.transactionStatus('pending'));
```

### Asserting what the SDK sent

```ts
await client.getQuote({ sourceAsset: 'USDC', amount: '5000', targetAddress: MOCK_C_ADDRESS });
const req = mock.requests[0];
expect(req.method).toBe('GET');
expect(req.pathname).toBe('/api/v1/quote');
expect(req.searchParams['sourceAsset']).toBe('USDC');
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
| `fixtures.transaction(overrides?)` | `Transaction` |
| `fixtures.tokenMetadata(overrides?)` | `TokenMetadata` |

Pre-built constants: `MOCK_C_ADDRESS`, `MOCK_G_ADDRESS`, `MOCK_TOKEN_ADDRESS`, `MOCK_TX_HASH`, `MOCK_QUOTE_PARAMS`, `MOCK_FUND_PARAMS`, `MOCK_NATIVE_TOKEN`, `MOCK_SAC_TOKEN`, `MOCK_TOKEN_METADATA`.
