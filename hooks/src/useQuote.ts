import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeClientConfig, Quote, QuoteParams } from '@c-address-bridge/sdk';
import { useCAddressBridge } from './useCAddressBridge.js';

export interface UseQuoteOptions {
  /** When false, the quote is not fetched. Defaults to true. */
  enabled?: boolean;
}

export interface UseQuoteResult {
  /** The quote for the current `params`; reset to `undefined` when `params` change. */
  data: Quote | undefined;
  error: Error | undefined;
  loading: boolean;
  /** Re-runs the quote request, bypassing the SDK's quote cache. */
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
  const paramsRef = useRef(params);
  paramsRef.current = params;

  // Drop the previous quote as soon as params change so it is never shown
  // against an amount/asset it was not calculated for.
  const [dataParamsKey, setDataParamsKey] = useState(paramsKey);
  if (dataParamsKey !== paramsKey) {
    setDataParamsKey(paramsKey);
    setData(undefined);
    setError(undefined);
  }

  useEffect(() => {
    if (!enabled || !params) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);

    client
      .getQuote(params, { signal: controller.signal })
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
      controller.abort();
      setLoading(false);
    };
  }, [client, paramsKey, enabled, refetchToken]);

  const refetch = useCallback(() => {
    if (paramsRef.current) client.invalidateQuoteCache(paramsRef.current);
    setRefetchToken((n) => n + 1);
  }, [client]);

  return { data, error, loading, refetch };
}
