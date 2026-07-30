import { useCallback, useEffect, useState } from 'react';
import type { BridgeClientConfig, Quote, QuoteParams } from '@c-address-bridge/sdk';
import { useCAddressBridge } from './useCAddressBridge';

export interface UseQuoteOptions {
  /** When false, the quote is not fetched. Defaults to true. */
  enabled?: boolean;
}

export interface UseQuoteResult {
  data: Quote | undefined;
  error: Error | undefined;
  loading: boolean;
  /** Re-runs the quote request, bypassing nothing but re-triggering the fetch effect. */
  refetch: () => void;
}

/**
 * Fetches a fee quote for the given params and keeps `data`/`error`/`loading`
 * in sync as `params` change.
 */
export function useQuote(
  config: BridgeClientConfig,
  params: QuoteParams | undefined,
  options: UseQuoteOptions = {},
): UseQuoteResult {
  const { enabled = true } = options;
  const client = useCAddressBridge(config);
  const [data, setData] = useState<Quote | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [refetchToken, setRefetchToken] = useState(0);

  const paramsKey = params ? JSON.stringify(params) : undefined;

  useEffect(() => {
    if (!enabled || !params) {
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(undefined);

    client
      .getQuote(params)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, paramsKey, enabled, refetchToken]);

  const refetch = useCallback(() => setRefetchToken((n) => n + 1), []);

  return { data, error, loading, refetch };
}
