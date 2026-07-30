# CEX Withdrawal Routing — Reference Implementation

## Overview

This module provides a reference implementation for routing CEX (centralized exchange) withdrawals directly to Soroban C-addresses. Exchanges can integrate this pattern to support smart account withdrawals without requiring users to understand the G → C address migration.

## Architecture

```
User → CEX Withdrawal UI
         │
         ▼
    WithdrawalRouter.routeWithdrawal(exchange, request)
         │
         ▼
    Exchange-specific handler (binance | coinbase | kraken)
         │
         ▼
    Soroban Bridge Contract → C-address funded
```

## Integration Guide

### For Exchanges

1. Register your exchange handler:
```ts
import { WithdrawalRouter, defaultCexHandlers } from './withdrawal-router';

const router = new WithdrawalRouter();
router.registerExchange('your-exchange', {
  name: 'your-exchange',
  apiBaseUrl: 'https://api.your-exchange.com',
  apiKey: process.env.API_KEY,
  apiSecret: process.env.API_SECRET,
}, async (req, config) => {
  // Implement your exchange's withdrawal API call
  // Then route through the bridge contract
  return {
    success: true,
    withdrawalId: '...',
    status: 'pending',
  };
});
```

> **`defaultCexHandlers` are non-functional placeholders.** `binance`, `coinbase`, and `kraken`
> in `defaultCexHandlers` never call an exchange API — they immediately return a fake
> `success: true` / `status: 'pending'` result. They exist only to illustrate the handler
> shape shown above. Registering them directly with `WithdrawalRouter` (instead of writing your
> own handler, as shown in the snippet) will silently "succeed" without ever moving funds. Always
> implement and register your own handler before routing real withdrawals.

2. Use the bridge memo format for tracking:
- Format: `bridge:{exchange_name}:{c_address_suffix}`
- Example: `bridge:binance:AB12CD34`

### For Wallets

Route CEX withdrawals through the bridge API:

```ts
const result = await bridgeClient.routeCexWithdrawal({
  exchange: 'binance',
  sourceAsset: 'XLM',
  amount: '10000000',  // 1 XLM in stroops
  targetCAddress: 'C...',
  targetNetwork: 'stellar',
});
```
