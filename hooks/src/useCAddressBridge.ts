import { useMemo } from 'react';
import { BridgeClient, type BridgeClientConfig } from '@c-address-bridge/sdk';

/**
 * Creates a `BridgeClient` for use inside a React component, memoized so a
 * new client (and its request cache) is only created when the config
 * actually changes rather than on every render.
 *
 * The client is keyed on each individual config field; function-valued
 * options such as `retry.logger` are compared by reference, so passing a new
 * callback creates a new client. Callers should therefore memoise callbacks
 * (e.g. with `useCallback`/`useMemo`), or keep the config object stable,
 * to avoid recreating the client on every render.
 */
export function useCAddressBridge(config: BridgeClientConfig): BridgeClient {
  const { baseUrl, apiKey, locale, signing, retry, cache, telemetry } = config;

  return useMemo(
    () => new BridgeClient(config),
    // Keyed on the fields below rather than on the object identity.
    [
      baseUrl,
      apiKey,
      locale,
      signing?.enabled,
      signing?.clockSkewToleranceMs,
      retry?.maxRetries,
      retry?.baseDelayMs,
      retry?.maxDelayMs,
      retry?.retryBudgetMs,
      retry?.jitterMs,
      retry?.logger,
      cache?.quoteTtlMs,
      cache?.statusTtlMs,
      cache?.healthTtlMs,
      cache?.staleWhileRevalidate,
      cache?.maxEntries,
      telemetry?.endpoint,
      telemetry?.enabled,
      telemetry?.intervalMs,
    ],
  );
}
