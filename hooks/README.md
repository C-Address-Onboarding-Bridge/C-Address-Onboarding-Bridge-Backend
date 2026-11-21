# @c-address-bridge/react-hooks

React hooks for the C-Address Onboarding Bridge SDK.

## Installation

```bash
npm install @c-address-bridge/react-hooks @c-address-bridge/sdk react
```

## `useCAddressBridge`

Creates and memoizes a `BridgeClient` for use inside a React component. The client is destroyed when the component unmounts or when the config changes, so its telemetry timers do not outlive the component.

```tsx
import { useCAddressBridge } from '@c-address-bridge/react-hooks';

function MyComponent() {
  const client = useCAddressBridge({
    baseUrl: 'https://api.bridge.example.com',
    apiKey: 'my-api-key',
  });

  // client is stable across renders unless config changes
  // ...
}
```

## `useQuote`

Fetches a fee quote for the given parameters and keeps `data`, `error`, and `loading` in sync as parameters change. The previous quote is cleared immediately when parameters change so a stale fee is never displayed.

```tsx
import { useQuote } from '@c-address-bridge/react-hooks';

const config = { baseUrl: 'https://api.bridge.example.com', apiKey: 'my-key' };

function QuoteDisplay() {
  const { data, error, loading, refetch } = useQuote(config, {
    sourceAsset: 'XLM',
    amount: '10000000',
    targetAddress: 'C...',
  });

  if (loading) return <p>Loading quote...</p>;
  if (error)   return <p>Error: {error.message}</p>;
  if (!data)   return null;

  return (
    <div>
      <p>Fee: {data.estimatedFee} stroops ({data.feeBps} bps)</p>
      <p>You receive: {data.expectedReceive} stroops</p>
      <button onClick={refetch}>Refresh</button>
    </div>
  );
}
```

| Return field | Type | Description |
|---|---|---|
| `data` | `Quote \| undefined` | Current quote; `undefined` while loading or if params changed |
| `error` | `Error \| undefined` | Last fetch error |
| `loading` | `boolean` | `true` while a request is in-flight |
| `refetch` | `() => void` | Re-runs the request, bypassing the SDK's quote cache |

Options:

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Set to `false` to suppress fetching |

## `useTransactionStatus`

Fetches the status of a submitted transaction by hash. Optionally polls until the transaction reaches a terminal state (`success` or `failed`). Failed requests during polling use exponential backoff (capped at 30 s).

```tsx
import { useTransactionStatus } from '@c-address-bridge/react-hooks';

const config = { baseUrl: 'https://api.bridge.example.com', apiKey: 'my-key' };

function StatusBadge({ txHash }: { txHash: string }) {
  const { data, error, loading } = useTransactionStatus(config, txHash, {
    pollIntervalMs: 3_000, // poll every 3 s until success or failed
  });

  if (loading && !data) return <span>Checking...</span>;
  if (error)            return <span>Error: {error.message}</span>;
  if (!data)            return null;

  return <span>Status: {data.status}</span>;
}
```

| Return field | Type | Description |
|---|---|---|
| `data` | `TransactionStatus \| undefined` | Latest status |
| `error` | `Error \| undefined` | Last fetch error |
| `loading` | `boolean` | `true` while a request is in-flight |

Options:

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Set to `false` to suppress fetching |
| `pollIntervalMs` | `number` | — | When set, polls at this interval until a terminal status is reached |

## `useFund`

Drives the full funding flow: **prepare → sign in wallet → submit → poll status**. Manages step state, idempotency keys, and error handling.

```tsx
import { useFund } from '@c-address-bridge/react-hooks';

const config = { baseUrl: 'https://api.bridge.example.com', apiKey: 'my-key' };

function FundButton() {
  const fund = useFund(config, { pollIntervalMs: 3_000 });

  const handleFund = async () => {
    // Step 1: prepare the unsigned transaction
    const prepared = await fund.prepare({
      sourceAddress: 'G...',
      targetAddress: 'C...',
      tokenAddress: 'CC...',
      amount: '10000000',
    });

    // Step 2: sign prepared.unsignedXdr with the user's wallet
    // e.g. with Freighter: const { signedTxXdr } = await signTransaction(prepared.unsignedXdr, { ... });
    const signedXdr = prepared.unsignedXdr; // replace with real signing

    // Step 3: submit
    await fund.submit(signedXdr);
  };

  if (fund.error)  return <p>Error: {fund.error.message} <button onClick={fund.reset}>Retry</button></p>;
  if (fund.status) return <p>Transaction {fund.result?.hash}: {fund.status.status}</p>;

  return (
    <button onClick={handleFund} disabled={fund.step !== 'idle'}>
      {fund.step === 'idle'       && 'Fund'}
      {fund.step === 'preparing'  && 'Preparing...'}
      {fund.step === 'prepared'   && 'Sign in wallet...'}
      {fund.step === 'submitting' && 'Submitting...'}
      {fund.step === 'submitted'  && 'Submitted!'}
    </button>
  );
}
```

| Return field | Type | Description |
|---|---|---|
| `step` | `FundStep` | Current flow step: `'idle' \| 'preparing' \| 'prepared' \| 'submitting' \| 'submitted' \| 'error'` |
| `prepared` | `FundingPrepareResult \| undefined` | Result of `prepare()` — contains `unsignedXdr` to sign |
| `result` | `FundingResult \| undefined` | Result of `submit()` — contains `hash` |
| `status` | `TransactionStatus \| undefined` | Live polled status of the submitted transaction |
| `error` | `Error \| undefined` | Error from any step |
| `idempotencyKey` | `string \| undefined` | Stable key for the current attempt; reused on retry |
| `prepare(params)` | `(FundParams) => Promise<FundingPrepareResult>` | Starts a new attempt and prepares the transaction |
| `submit(signedXdr)` | `(string) => Promise<FundingResult>` | Submits the signed XDR and starts polling |
| `reset()` | `() => void` | Clears all state and returns to `idle` |

Options:

| Option | Type | Default | Description |
|---|---|---|---|
| `pollIntervalMs` | `number` | `3000` | How often to poll the submitted transaction's status |
