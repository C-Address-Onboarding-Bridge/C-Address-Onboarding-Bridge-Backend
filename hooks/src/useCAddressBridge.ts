import { useMemo } from 'react';
import { BridgeClient, type BridgeClientConfig } from '@c-address-bridge/sdk';

/**
 * Creates or accepts a `BridgeClient` for use inside a React component.
 *
 * If a `BridgeClient` instance is provided directly, it is returned as-is.
 * When a configuration object is provided, the client is memoized based on its
 * individual options (including primitive properties and function callbacks)
 * rather than serializing via JSON.stringify.
 *
 * Callers passing dynamic configuration objects should memoize the object
 * or provide stable callback references.
 */
export function useCAddressBridge(config: BridgeClientConfig | BridgeClient): BridgeClient {
  if (config instanceof BridgeClient) {
    return config;
  }

  const {
    baseUrl,
    apiKey,
    locale,
    signing,
    retry,
    cache,
    telemetry,
  } = config;

  return useMemo(
    () => new BridgeClient(config),
    [
      baseUrl,
      apiKey,
      locale,
      signing,
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
