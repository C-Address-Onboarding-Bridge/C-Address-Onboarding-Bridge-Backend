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

All `BridgeClient` methods throw a typed `BridgeError` on failure. The SDK provides a
hierarchy of error classes and type-guard helpers so you can handle errors precisely
instead of relying on string matching.

### Typed Error Hierarchy

| Error Class | `type` | `statusCode` | Retryable | Use Case |
|-------------|--------|--------------|-----------|----------|
| `AuthError` | `'AuthError'` | 401 / 403 | No | Missing or invalid `X-API-Key` header |
| `ValidationError` | `'ValidationError'` | 400 / 422 | No | Invalid query parameter, malformed address, or bad input |
| `NotFoundError` | `'NotFoundError'` | 404 | No | Resource doesn't exist |
| `RateLimitError` | `'RateLimitError'` | 429 | Yes | Too many requests (includes `retryAfterMs`) |
| `ServerError` | `'ServerError'` | 500+ | Yes | Server-side failure |
| `NetworkError` | `'NetworkError'` | — | Yes | Connectivity lost (no HTTP response) |
| `TimeoutError` | `'TimeoutError'` | — | Yes | Request timed out (includes `timeoutMs` and `operation`) |
| `OfflineError` | `'OfflineError'` | — | No | Client is offline (includes `queued` flag) |
| `QueueFullError` | `'QueueFullError'` | — | No | Offline queue capacity exceeded |
| `BridgeError` | `'BridgeError'` | varies | varies | Fallback base class |

### Using Type Guards

The SDK exports type-guard functions for every error class. Use them in `instanceof`-style
checks or with `catch` blocks for precise handling:

```typescript
import {
  BridgeClient,
  isAuthError,
  isValidationError,
  isRateLimitError,
  isNetworkError,
  isTimeoutError,
  isBridgeError,
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
    // 401 or 403 — prompt user to re-authenticate
    console.error(`Auth error (${err.statusCode}):`, err.message);
  } else if (isValidationError(err)) {
    // 400 or 422 — show inline field error
    console.error('Validation error:', err.message);
    if (err.fields) {
      for (const [field, msg] of Object.entries(err.fields)) {
        console.error(`  ${field}: ${msg}`);
      }
    }
  } else if (isRateLimitError(err)) {
    // 429 — wait and retry
    const delay = err.retryAfterMs ?? 5000;
    console.warn(`Rate limited, retrying in ${delay}ms`);
    await new Promise(r => setTimeout(r, delay));
    // re-execute request...
  } else if (isTimeoutError(err)) {
    // Request timed out — retry with backoff
    console.warn(`Operation "${err.operation}" timed out after ${err.timeoutMs}ms`);
  } else if (isNetworkError(err)) {
    // Connection lost — wait for connectivity
    console.warn('Network error:', err.message);
  } else if (isBridgeError(err)) {
    // Any BridgeError (generic fallback)
    console.error('Bridge error:', err.message, `(retryable: ${err.retryable})`);
  } else {
    // Unexpected non-BridgeError (shouldn't happen)
    console.error('Unexpected error:', err);
  }
}
```

Requests time out after **30 seconds**. Implement retry logic with exponential backoff
in your application as needed. The `retryable` property on every `BridgeError` tells you
whether a retry is safe.

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
