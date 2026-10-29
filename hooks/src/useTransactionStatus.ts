import { useEffect, useState } from 'react';
import type { BridgeClientConfig, TransactionStatus } from '@c-address-bridge/sdk';
import { useCAddressBridge } from './useCAddressBridge.js';

export interface UseTransactionStatusOptions {
  /** When false, the status is not fetched. Defaults to true. */
  enabled?: boolean;
  /**
   * When set, polls at this interval (ms) until the status is `success` or
   * `failed`. Failed requests are retried with exponential backoff (capped at
   * 30s) rather than ending the polling.
   */
  pollIntervalMs?: number;
}

export interface UseTransactionStatusResult {
  data: TransactionStatus | undefined;
  error: Error | undefined;
  loading: boolean;
}

const TERMINAL_STATUSES = new Set(['success', 'failed']);
const MAX_ERROR_BACKOFF_MS = 30_000;

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

  // Drop the previous transaction's status/error as soon as txHash changes.
  const [dataTxHash, setDataTxHash] = useState(txHash);
  if (dataTxHash !== txHash) {
    setDataTxHash(txHash);
    setData(undefined);
    setError(undefined);
  }

  useEffect(() => {
    if (!enabled || !txHash) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveErrors = 0;

    const fetchStatus = () => {
      setLoading(true);
      client
        .getStatus(txHash)
        .then((result) => {
          if (cancelled) return;
          consecutiveErrors = 0;
          setData(result);
          setError(undefined);
          if (pollIntervalMs && !TERMINAL_STATUSES.has(result.status)) {
            timer = setTimeout(fetchStatus, pollIntervalMs);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err : new Error(String(err)));
          if (pollIntervalMs) {
            consecutiveErrors += 1;
            const backoff = Math.max(pollIntervalMs, Math.min(pollIntervalMs * 2 ** consecutiveErrors, MAX_ERROR_BACKOFF_MS));
            timer = setTimeout(fetchStatus, backoff);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    fetchStatus();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      setLoading(false);
    };
  }, [client, txHash, enabled, pollIntervalMs]);

  return { data, error, loading };
}
