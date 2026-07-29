# Wallet Integration Guide

This guide shows how wallets and dApps integrate the C-Address Onboarding Bridge SDK to fund Soroban smart accounts (C-addresses) directly — without requiring the end user to have a traditional G-address first.

> **Video walkthrough:** [Integrating the SDK into a wallet](video-walkthroughs.md#2-integrating-the-sdk-into-a-wallet) · [MoonPay on-ramp](video-walkthroughs.md#3-setting-up-moonpay-fiat-on-ramp) · [CEX withdrawals](video-walkthroughs.md#4-configuring-cex-withdrawals)  
> Play locally: `asciinema play docs/videos/casts/wallet-integration.cast`

## Table of Contents

- [Address Detection](#address-detection)
- [Getting Started](#getting-started)
- [Funding Flows](#funding-flows)
  - [1. G-Address → C-Address](#1-g-address--c-address)
  - [2. CEX Withdrawal → C-Address](#2-cex-withdrawal--c-address)
  - [3. Credit Card → C-Address](#3-credit-card--c-address)
- [Error Handling](#error-handling)
- [Contract Addresses](#contract-addresses)

---

## Address Detection

Before initiating any funding flow, detect whether the recipient is a C-address (Soroban smart account) or a traditional G-address so you can route correctly.

```typescript
import { utils } from '@c-address-bridge/sdk';

const recipient = 'C...';

if (utils.isCAddress(recipient)) {
  // Use the bridge to fund a Soroban smart account
} else if (utils.isGAddress(recipient)) {
  // Use a standard Stellar payment operation
} else {
  throw new Error('Invalid address');
}
```

C-addresses start with `C` and are 56 characters long (base32). G-addresses start with `G` and follow the same format. `utils.isValidStellarAddress` accepts both.

---

## Getting Started

Install the SDK:

```bash
npm install @c-address-bridge/sdk
```

Create a client with your API key:

```typescript
import { BridgeClient } from '@c-address-bridge/sdk';

const client = new BridgeClient({
  baseUrl: 'https://api.bridge.example.com',
  apiKey: 'your-api-key',   // sent as X-API-Key on every request
});
```

All endpoints require an API key. Contact the bridge operator to obtain one.

---

## Funding Flows

### 1. G-Address → C-Address

Use when a sender with an existing Stellar G-address wants to fund a Soroban smart account.

#### Step 1 — Get a quote

```typescript
const quote = await client.getQuote({
  sourceAsset: 'XLM',
  amount: '10000000',        // 1 XLM in stroops
  targetAddress: 'C...',
});

console.log(`Fee: ${quote.estimatedFee} stroops (${quote.feeBps} bps)`);
console.log(`Recipient receives: ${quote.expectedReceive} stroops`);
```

Quotes are cached for 30 seconds server-side, so polling is safe.

#### Step 2 — Prepare the funding transaction

```typescript
const prepared = await client.prepareFundingTransaction({
  sourceAddress: 'G...',
  targetAddress: 'C...',
  tokenAddress: 'CC...',     // SEP-41 token contract address
  amount: '10000000',
  memo: 'onboarding',        // optional
});

// prepared.instruction is a base64 XDR transaction envelope ready to sign
```

#### Step 3 — Sign in the wallet

Pass `prepared.instruction` to the user's wallet for signing. The exact API depends on the wallet SDK:

```typescript
// Generic example — replace with your wallet's signing API
const signedXdr = await wallet.signTransaction(prepared.instruction, {
  networkPassphrase: 'Test SDF Network ; September 2015',
});
```

#### Step 4 — Submit the signed transaction

```typescript
const result = await client.submitSignedXdr({ signedXdr });

console.log(`Status: ${result.status}`);   // 'pending' | 'success' | 'failed'
console.log(`Hash: ${result.hash}`);
```

#### Step 5 — Poll for confirmation (optional)

```typescript
const status = await client.getStatus(result.hash);
console.log(status.status); // 'pending' | 'success' | 'failed'
```

---

### 2. CEX Withdrawal → C-Address

Use when the user is withdrawing from a centralised exchange directly to a C-address.

```typescript
const result = await client.routeCexWithdrawal({
  exchange: 'binance',        // 'binance' | 'coinbase' | 'kraken' | 'generic'
  sourceAsset: 'XLM',
  amount: '10000000',
  targetCAddress: 'C...',
  targetNetwork: 'stellar',
  memo: 'bridge:binance:ABCD1234',  // used to correlate the on-chain withdrawal
});

console.log(`Withdrawal ID: ${result.withdrawalId}`);
console.log(`ETA: ${result.estimatedArrival}`);
```

The bridge operator configures the exchange API credentials. The memo format `bridge:{exchange}:{suffix}` allows the bridge to match incoming deposits to withdrawal requests.

---

### 3. Credit Card → C-Address

Let users buy crypto with a card and land directly in a C-address via Moonpay or Transak.

#### Moonpay

```typescript
const moonpay = await client.createMoonpayUrl({
  walletAddress: 'C...',
  currencyCode: 'xlm',
  walletNetwork: 'stellar',
  baseCurrencyAmount: 100,
  baseCurrencyCode: 'USD',
  email: 'user@example.com',  // optional, pre-fills the Moonpay form
});

window.open(moonpay.url);
```

#### Transak

```typescript
const transak = await client.createTransakUrl({
  walletAddress: 'C...',
  network: 'stellar',
  fiatCurrency: 'USD',
  cryptoCurrency: 'XLM',
  fiatAmount: 100,
  redirectURL: 'https://your-app.com/success',
});

window.open(transak.url);
```

After the user completes the purchase, the provider sends a webhook to the bridge, which routes the funds to the C-address automatically.

---

## Error Handling

`BridgeClient` methods throw typed subclasses of `BridgeError` (from `errors.ts`), not a native `Error`. Every error carries a `statusCode`, an optional `code`, and a `retryable` flag, and the SDK exports type guards (`isAuthError`, `isValidationError`, etc.) so you can branch on error type instead of parsing `err.message`.

```typescript
import {
  BridgeClient,
  isAuthError,
  isValidationError,
  isRateLimitError,
  isServerError,
  isNetworkError,
  isNotFoundError,
} from '@c-address-bridge/sdk';

const client = new BridgeClient({ baseUrl: '...', apiKey: '...' });

try {
  const quote = await client.getQuote({
    sourceAsset: 'XLM',
    amount: '10000000',
    targetAddress: 'C...',
  });
} catch (err) {
  if (isAuthError(err)) {
    // Prompt user to re-authenticate or contact support
  } else if (isValidationError(err)) {
    // err.fields holds a map of field name -> validation message, when provided
    console.error('Invalid fields:', err.fields);
  } else if (isRateLimitError(err)) {
    // err.retryAfterMs suggests how long to wait before retrying
    console.error(`Rate limited, retry after ${err.retryAfterMs}ms`);
  } else if (isNotFoundError(err)) {
    // Requested resource does not exist
  } else if (isServerError(err) || isNetworkError(err)) {
    // err.retryable is true for both — safe to retry with backoff
    console.error('Transient error, safe to retry:', err.message);
  } else {
    console.error('Bridge error:', err);
  }
}
```

`BridgeError.isRetryable(err)` is a static helper equivalent to checking `err instanceof BridgeError && err.retryable` — useful in generic retry wrappers that don't need to distinguish error types.

Typed error classes and their default messages:

| Class | Default message | statusCode | retryable | Guard |
|-------|------------------|------------|-----------|-------|
| `AuthError` | `Unauthorized` | 401 or 403 | `false` | `isAuthError` |
| `ValidationError` | *(required)* | 400 or 422 | `false` | `isValidationError` |
| `NotFoundError` | `Not found` | 404 | `false` | `isNotFoundError` |
| `RateLimitError` | `Too many requests` | 429 | `true` | `isRateLimitError` |
| `ServerError` | *(required)* | 500+ | `true` | `isServerError` |
| `NetworkError` | `Network error` | — | `true` | `isNetworkError` |
| `TimeoutError` | `Operation "{op}" timed out after {ms}ms` | — | `true` | `isTimeoutError` |

All of the above extend `BridgeError`, which itself extends `Error` — `isBridgeError(err)` narrows any thrown value to the base type, and `err instanceof Error` still works for a coarse check.

Requests time out after **30 seconds**, surfaced as a `TimeoutError`. Use the `retryable` flag (or the corresponding type guard) to decide whether to retry with exponential backoff in your application.

---

## Contract Addresses

| Network | Contract ID |
|---------|-------------|
| Testnet | `CD3YJ3M7PQ5PF7XT4NL2AX7XINJWXZ7TAIHY36NI6NWW2UABAAOAFAIC` |
| Mainnet | TBD |

**Testnet**
- RPC URL: `https://soroban-rpc.testnet.stellar.org`
- Network passphrase: `Test SDF Network ; September 2015`

**Mainnet**
- RPC URL: `https://soroban-rpc.stellar.org`
- Network passphrase: `Public Global Stellar Network ; September 2015`
