import { useCallback, useRef, useState } from 'react';
import {
  utils,
  type BridgeClientConfig,
  type FundParams,
  type FundingPrepareResult,
  type FundingResult,
  type TransactionStatus,
} from '@c-address-bridge/sdk';
import { useCAddressBridge } from './useCAddressBridge';
import { useTransactionStatus } from './useTransactionStatus';

export type FundStep = 'idle' | 'preparing' | 'prepared' | 'submitting' | 'submitted' | 'error';

export interface UseFundOptions {
  /** How often (ms) to poll the submitted transaction's status. Defaults to 3000. */
  pollIntervalMs?: number;
}

export interface UseFundResult {
  step: FundStep;
  /** Result of the last `prepare()` call: the transaction for the wallet to sign. */
  prepared: FundingPrepareResult | undefined;
  /** Result of the last `submit()` call. */
  result: FundingResult | undefined;
  /** Live status of the submitted transaction, polled until `success` or `failed`. */
  status: TransactionStatus | undefined;
  error: Error | undefined;
  /**
   * Idempotency key of the current funding attempt. It is created by
   * `prepare()` (or the first `submit()`), reused if `submit()` is called
   * again for the same attempt so the server can deduplicate it, and cleared
   * by `reset()`.
   */
  idempotencyKey: string | undefined;
  /** Prepares an unsigned funding transaction and starts a new attempt. Rejects on failure. */
  prepare: (_params: FundParams) => Promise<FundingPrepareResult>;
  /** Submits the wallet-signed XDR, then follows its status. Rejects on failure. */
  submit: (_signedXdr: string) => Promise<FundingResult>;
  /** Clears all state and ends the current attempt. */
  reset: () => void;
}

/**
 * Drives the funding flow: prepare → sign in the wallet → submit → status.
 *
 * @example
 * ```tsx
 * import { signTransaction } from '@stellar/freighter-api';
 *
 * function FundButton({ params }: { params: FundParams }) {
 *   const fund = useFund({ baseUrl: 'https://bridge.example.com', apiKey });
 *
 *   const onClick = async () => {
 *     const prepared = await fund.prepare(params);
 *     const { signedTxXdr } = await signTransaction(prepared.instruction, {
 *       networkPassphrase: 'Test SDF Network ; September 2015',
 *     });
 *     await fund.submit(signedTxXdr);
 *   };
 *
 *   if (fund.error) return <p>Funding failed: {fund.error.message}</p>;
 *   if (fund.status) return <p>Transaction {fund.status.hash}: {fund.status.status}</p>;
 *   return <button onClick={onClick} disabled={fund.step !== 'idle'}>Fund</button>;
 * }
 * ```
 */
export function useFund(config: BridgeClientConfig, options: UseFundOptions = {}): UseFundResult {
  const { pollIntervalMs = 3000 } = options;
  const client = useCAddressBridge(config);
  const [step, setStep] = useState<FundStep>('idle');
  const [prepared, setPrepared] = useState<FundingPrepareResult | undefined>(undefined);
  const [result, setResult] = useState<FundingResult | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [idempotencyKey, setIdempotencyKey] = useState<string | undefined>(undefined);

  // Bumped by prepare()/reset() so responses from an abandoned attempt are ignored.
  const attemptRef = useRef(0);
  const keyRef = useRef<string | undefined>(undefined);

  const status = useTransactionStatus(config, result?.hash, { enabled: !!result, pollIntervalMs });

  const fail = (attempt: number, err: unknown): Error => {
    const e = err instanceof Error ? err : new Error(String(err));
    if (attempt === attemptRef.current) {
      setError(e);
      setStep('error');
    }
    return e;
  };

  const prepare = useCallback(
    async (params: FundParams) => {
      const attempt = ++attemptRef.current;
      keyRef.current = utils.generateIdempotencyKey();
      setIdempotencyKey(keyRef.current);
      setPrepared(undefined);
      setResult(undefined);
      setError(undefined);
      setStep('preparing');
      try {
        const res = await client.prepareFundingTransaction(params);
        if (attempt === attemptRef.current) {
          setPrepared(res);
          setStep('prepared');
        }
        return res;
      } catch (err) {
        throw fail(attempt, err);
      }
    },
    [client],
  );

  const submit = useCallback(
    async (signedXdr: string) => {
      const attempt = attemptRef.current;
      if (!keyRef.current) {
        keyRef.current = utils.generateIdempotencyKey();
        setIdempotencyKey(keyRef.current);
      }
      setError(undefined);
      setStep('submitting');
      try {
        const res = await client.submitSignedXdr({ signedXdr }, { idempotencyKey: keyRef.current });
        if (attempt === attemptRef.current) {
          setResult(res);
          setStep('submitted');
        }
        return res;
      } catch (err) {
        throw fail(attempt, err);
      }
    },
    [client],
  );

  const reset = useCallback(() => {
    attemptRef.current++;
    keyRef.current = undefined;
    setIdempotencyKey(undefined);
    setPrepared(undefined);
    setResult(undefined);
    setError(undefined);
    setStep('idle');
  }, []);

  return {
    step,
    prepared,
    result,
    status: result ? status.data : undefined,
    error: error ?? (result ? status.error : undefined),
    idempotencyKey,
    prepare,
    submit,
    reset,
  };
}
