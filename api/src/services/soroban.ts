import {
  Transaction,
  xdr,
  Contract,
  Address,
  Keypair,
  Account,
  TransactionBuilder,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { config } from '../config';
import { rpcPool } from './rpcPool';
import { externalCallDuration } from './metrics';
import { validateXdr, XdrValidationError } from './xdrValidator';
import { logger } from '../logger';

const tracer = trace.getTracer('soroban-service');

/** Shape of a Soroban transaction response returned by the API. */
export interface SorobanTxResponse {
  status: 'pending' | 'success' | 'failed' | 'expired';
  hash: string;
  error?: string;
}

/**
 * Error thrown when the Soroban RPC asks the caller to retry later
 * (`TRY_AGAIN_LATER`). The transaction was NOT accepted, so callers must
 * surface this as a retryable failure (HTTP 503) rather than a success.
 */
export class SorobanRetryableError extends Error {
  readonly code = 'TRY_AGAIN_LATER';

  constructor(message = 'Soroban RPC is congested; retry later') {
    super(message);
    this.name = 'SorobanRetryableError';
  }
}

/**
 * Error thrown when the Soroban RPC cannot be reached or returns an
 * unexpected failure. Callers must surface this as a retryable failure
 * (HTTP 503) instead of silently reporting `pending`.
 */
export class SorobanRpcError extends Error {
  readonly code = 'RPC_ERROR';

  constructor(message = 'Soroban RPC request failed', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SorobanRpcError';
  }
}

const BASIS_POINTS_DENOM = 10000;

/**
 * Default RPC retention window (in seconds) after which a transaction that is
 * still `NOT_FOUND` can no longer be included and is considered expired.
 * Soroban RPCs typically retain ~24h of ledger history.
 */
const DEFAULT_RPC_RETENTION_SECONDS = 24 * 60 * 60;

/**
 * Tracks the time bounds (unix seconds) of transactions we have submitted so
 * that a persistent `NOT_FOUND` can be reported as `expired` once the
 * transaction's own validity window has elapsed.
 */
const submittedTxTimeBounds = new Map<string, { maxTime: number; submittedAt: number }>();

/** Wraps the Soroban RPC server and bridge contract interactions. */
export class SorobanService {
  private networkPassphrase: string;
  private contractId: string;

  constructor() {
    this.networkPassphrase = config.soroban.networkPassphrase;
    this.contractId = config.soroban.bridgeContractId;
  }

  /**
   * Returns a fee quote for a prospective funding transaction.
   * Rate is currently fixed at 1:1; replace with live price feed when available.
   *
   * @param _sourceAsset - Asset code (e.g. `XLM`, `USDC`). Reserved for future rate lookup.
   * @param amount - Amount in stroops as an integer string.
   * @param _targetAddress - Destination C-address. Reserved for future per-address logic.
   */
  async getQuote(
    _sourceAsset: string,
    amount: string,
    _targetAddress: string,
  ): Promise<{
    estimatedFee: string;
    expectedReceive: string;
    feeBps: number;
    rate: string;
  }> {
    return tracer.startActiveSpan('quote.calculation', async (span) => {
      try {
        const feeBps = config.soroban.feeBps;
        const amountNum = BigInt(amount);
        const feeAmount = (amountNum * BigInt(feeBps)) / BigInt(BASIS_POINTS_DENOM);
        const receiveAmount = amountNum - feeAmount;

        span.setAttributes({ 'quote.fee_bps': feeBps, 'quote.amount': amount });
        return {
          estimatedFee: feeAmount.toString(),
          expectedReceive: receiveAmount.toString(),
          feeBps,
          rate: '1.0',
        };
      } finally {
        span.end();
      }
    });
  }

  /**
   * Validates and submits a signed Soroban transaction XDR to the network.
   *
   * Runs the full XDR validation pipeline before touching the RPC. Any
   * validation failure throws an `XdrValidationError` with a structured
   * `code` and `detail`; the caller should convert these to 400 responses.
   *
   * @param signedXdr - Base64-encoded signed transaction envelope.
   * @returns Transaction status and hash.
   * @throws {XdrValidationError} If the XDR fails any validation rule.
   * @throws {SorobanRetryableError} If the RPC returns `TRY_AGAIN_LATER`.
   */
  async submitFundingTransaction(
    signedXdr: string,
  ): Promise<SorobanTxResponse> {
    return tracer.startActiveSpan('soroban.submitFundingTransaction', async (span): Promise<SorobanTxResponse> => {
      const start = Date.now();
      try {
        // ── Validation pipeline ──────────────────────────────────────────────
        // Throws XdrValidationError on any rule failure — no network call is made.
        const validation = validateXdr(signedXdr);
        span.setAttributes({
          'tx.hash': validation.txHash,
          'tx.source': validation.sourceAccount,
          'tx.fee': validation.fee,
          'tx.op_count': validation.operationCount,
        });

        return await this.submitValidatedXdr(signedXdr, validation.txHash, span, start);
      } catch (err) {
        if (err instanceof XdrValidationError) {
          logger.warn(
            { code: err.code, detail: err.detail },
            'soroban.submitFundingTransaction: XDR validation rejected',
          );
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        }
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Shared submission path used by both single and batch funding flows.
   *
   * Re-parses the validated XDR, sends it to the RPC pool, and maps the
   * Soroban response status to the API's `SorobanTxResponse`:
   *
   * - `PENDING` / `DUPLICATE` → `pending` (accepted or already in flight)
   * - `ERROR` → `failed`
   * - `TRY_AGAIN_LATER` → throws `SorobanRetryableError` (HTTP 503)
   * - anything else → confirmed via `getTransaction` before reporting success
   */
  private async submitValidatedXdr(
    signedXdr: string,
    txHash: string,
    span: ReturnType<typeof tracer.startActiveSpan> extends never ? never : any,
    start: number,
  ): Promise<SorobanTxResponse> {
    const envelope = xdr.TransactionEnvelope.fromXDR(signedXdr, 'base64');
    const tx = new Transaction(envelope, this.networkPassphrase);

    // Record the transaction's time bounds so a later `NOT_FOUND` can be
    // distinguished from a transaction that is genuinely still in flight.
    this.rememberTimeBounds(txHash, tx);

    const sendResponse = await rpcPool.execute((server) => server.sendTransaction(tx));
    externalCallDuration.observe({ service: 'soroban' }, (Date.now() - start) / 1000);

    if (sendResponse.status === 'PENDING' || sendResponse.status === 'DUPLICATE') {
      return { status: 'pending' as const, hash: txHash };
    }
    if (sendResponse.status === 'ERROR') {
      span.setStatus({ code: SpanStatusCode.ERROR });
      return {
        status: 'failed' as const,
        hash: txHash,
        error: sendResponse.errorResult?.result().toString() || 'unknown error',
      };
    }
    if (sendResponse.status === 'TRY_AGAIN_LATER') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'TRY_AGAIN_LATER' });
      throw new SorobanRetryableError();
    }

    // Only report success once the network confirms the transaction.
    const confirmed = await this.getTransactionStatus(txHash);
    if (confirmed.status === 'success') {
      return { status: 'success' as const, hash: txHash };
    }
    return confirmed;
  }

  /**
   * Records the time bounds of a submitted transaction so that a persistent
   * `NOT_FOUND` can later be classified as `expired`.
   */
  private rememberTimeBounds(txHash: string, tx: Transaction): void {
    const maxTime = tx.timeBounds?.maxTime ? Number(tx.timeBounds.maxTime) : 0;
    submittedTxTimeBounds.set(txHash, { maxTime, submittedAt: Math.floor(Date.now() / 1000) });
  }

  /**
   * Returns true when a `NOT_FOUND` transaction can no longer be included:
   * either its own time bounds have elapsed, or the RPC retention window has
   * passed since submission.
   */
  private isExpired(txHash: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    const bounds = submittedTxTimeBounds.get(txHash);
    if (bounds) {
      if (bounds.maxTime > 0 && now > bounds.maxTime) {
        return true;
      }
      return now - bounds.submittedAt > DEFAULT_RPC_RETENTION_SECONDS;
    }
    // Unknown transaction: only treat as expired once the retention window has
    // elapsed since the epoch of first observation is unknowable, so stay pending.
    return false;
  }

  /**
   * Polls the Soroban RPC for the current status of a submitted transaction.
   *
   * - `NOT_FOUND` → `pending` while the transaction may still be included,
   *   `expired` once its time bounds or the RPC retention window have elapsed.
   * - `FAILED` → `failed`
   * - `SUCCESS` → `success`
   * - RPC/network errors → throws `SorobanRpcError` (HTTP 503) instead of
   *   silently reporting `pending`.
   *
   * @param txHash - Hex-encoded transaction hash.
   * @returns Latest known transaction status.
   * @throws {SorobanRpcError} If the RPC call fails.
   */
  async getTransactionStatus(txHash: string): Promise<SorobanTxResponse> {
    let tx: Awaited<ReturnType<Awaited<ReturnType<typeof rpcPool.execute>> extends never ? never : any>>;
    try {
      tx = await rpcPool.execute((server) => server.getTransaction(txHash));
    } catch (err) {
      logger.warn({ err, txHash }, 'soroban.getTransactionStatus: RPC request failed');
      throw new SorobanRpcError('Soroban RPC request failed', { cause: err });
    }

    if (tx.status === 'NOT_FOUND') {
      if (this.isExpired(txHash)) {
        submittedTxTimeBounds.delete(txHash);
        return { status: 'expired', hash: txHash, error: 'transaction expired without inclusion' };
      }
      return { status: 'pending', hash: txHash };
    }
    if (tx.status === 'FAILED') {
      submittedTxTimeBounds.delete(txHash);
      return { status: 'failed', hash: txHash, error: 'transaction failed' };
    }
    submittedTxTimeBounds.delete(txHash);
    return { status: 'success', hash: txHash };
  }

  /**
   * Simulates a contract call to obtain the resource footprint and minimum fee.
   *
   * Builds a `fund_c_address` contract invocation, simulates it against the
   * Soroban RPC, and returns the real footprint (XDR-encoded) and minResourceFee
   * so the caller can construct a properly-budgeted transaction.
   *
   * @param sourceAddress - Signing account address.
   * @param functionName - Contract function to simulate (e.g. `fund_c_address`).
   * @param targetAddress - Destination C-address.
   * @param tokenAddress - Token contract address.
   * @param amount - Amount in stroops as an integer string.
   * @param memo - Optional memo bytes.
   */
  async contractSimulate(
    sourceAddress: string,
   

/* … truncated 3175 chars — edit only what you need near the top … */
