import { useEffect, useState } from 'react';
import type { BridgeClientConfig, TransactionStatus } from '@c-address-bridge/sdk';
import { useCAddressBridge } from './useCAddressBridge';

export interface UseTransactionStatusOptions {
  /** When false, the status is not fetched. Defaults to true. */
  enabled?: boolean;
  /** When set, polls at this interval (ms) until the status is `success` or `failed`. */
  pollIntervalMs?: number;
}

export interface UseTransactionStatusResult {
  data: TransactionStatus | undefined;
  error: Error | undefined;
  loading: boolean;
}

const TERMINAL_STATUSES = new Set(['success', 'failed']);

/**
 * Fetches (and optionally polls) the status of a submitted transaction by hash.
 */
export function useTransactionStatus(
  config: BridgeClientConfig,
  txHash: string | undefined,
  options: UseTransactionStatusOptions = {},
): UseTransactionStatusResult {
  const { enabled = true, pollIntervalMs } = options;
  const client = useCAddressBridge(config);
  const [data, setData] = useState<TransactionStatus | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !txHash) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fetchStatus = () => {
      setLoading(true);
      client
        .getStatus(txHash)
        .then((result) => {
          if (cancelled) return;
          setData(result);
          setError(undefined);
          if (pollIntervalMs && !TERMINAL_STATUSES.has(result.status)) {
            timer = setTimeout(fetchStatus, pollIntervalMs);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    fetchStatus();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, txHash, enabled, pollIntervalMs]);

  return { data, error, loading };
}
