import { useMemo } from 'react';
import { BridgeClient, type BridgeClientConfig } from '@c-address-bridge/sdk';

/**
 * Creates a `BridgeClient` for use inside a React component, memoized so a
 * new client (and its request cache) is only created when the config
 * actually changes rather than on every render.
 */
export function useCAddressBridge(config: BridgeClientConfig): BridgeClient {
  const configKey = JSON.stringify(config);

  return useMemo(() => new BridgeClient(config), [configKey]);
}
