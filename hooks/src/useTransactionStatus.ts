import { useCallback, useEffect, useRef, useState } from 'react';
import { getStatus, type RequestOptions, type TransactionStatus } from '@c-address/sdk';

export interface UseTransactionStatusResult {
  status: TransactionStatus | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useTransactionStatus(
  txHash: string | null | undefined,
  options?: RequestOptions,
): UseTransactionStatusResult {
  const [status, setStatus] = useState<TransactionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const refetch = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!txHash) {
      setStatus(null);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    setLoading(true);
    setError(null);

    getStatus(txHash, { ...optionsRef.current, signal: controller.signal })
      .then((result) => {
        if (cancelled) return;
        setStatus(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [txHash, nonce]);

  return { status, loading, error, refetch };
}
