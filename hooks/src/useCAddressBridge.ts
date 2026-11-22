import { useEffect, useMemo } from 'react';
import { BridgeClient, type BridgeClientConfig } from '@c-address-bridge/sdk';

/**
 * Creates a `BridgeClient` for use inside a React component, memoized so a
 * new client (and its request cache) is only created when the config
 * actually changes rather than on every render.
 *
 * The memoized client is destroyed when the component unmounts or when the
 * config changes, so its telemetry timer does not outlive the component. In
 * browsers `unref()` does not exist, so without this every re-configured
 * component would leave an interval behind forever (#858).
 */
export function useCAddressBridge(config: BridgeClientConfig): BridgeClient {
  const configKey = JSON.stringify(config);
  const client = useMemo(() => new BridgeClient(config), [configKey]);

  useEffect(() => () => client.destroy(), [client]);

  return client;
}
