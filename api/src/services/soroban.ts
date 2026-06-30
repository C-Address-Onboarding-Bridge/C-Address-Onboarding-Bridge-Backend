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
  status: 'pending' | 'success' | 'failed';
  hash: string;
  error?: string;
}

const BASIS_POINTS_DENOM = 10000;

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

        // ── Submission ───────────────────────────────────────────────────────
        // Re-parse from the validated string (Transaction constructor already
        // ran inside validateXdr; we need the object for sendTransaction).
        const envelope = xdr.TransactionEnvelope.fromXDR(signedXdr, 'base64');
        const tx = new Transaction(envelope, this.networkPassphrase);

        const sendResponse = await rpcPool.execute((server) => server.sendTransaction(tx));
        externalCallDuration.observe({ service: 'soroban' }, (Date.now() - start) / 1000);

        if (sendResponse.status === 'PENDING') {
          return { status: 'pending' as const, hash: validation.txHash };
        }
        if (sendResponse.status === 'ERROR') {
          span.setStatus({ code: SpanStatusCode.ERROR });
          return {
            status: 'failed' as const,
            hash: validation.txHash,
            error: sendResponse.errorResult?.result().toString() || 'unknown error',
          };
        }
        return { status: 'success' as const, hash: validation.txHash };
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
   * Polls the Soroban RPC for the current status of a submitted transaction.
   *
   * @param txHash - Hex-encoded transaction hash.
   * @returns Latest known transaction status.
   */
  async getTransactionStatus(txHash: string): Promise<SorobanTxResponse> {
    try {
      const tx = await rpcPool.execute((server) => server.getTransaction(txHash));
      if (tx.status === 'NOT_FOUND') {
        return { status: 'pending', hash: txHash };
      }
      if (tx.status === 'FAILED') {
        return { status: 'failed', hash: txHash, error: 'transaction failed' };
      }
      return { status: 'success', hash: txHash };
    } catch {
      // TODO: distinguish RPC errors from "not found" so callers can detect
      // connectivity failures rather than treating them as a pending state.
      return { status: 'pending', hash: txHash };
    }
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
    functionName: string,
    targetAddress: string,
    tokenAddress: string,
    amount: string,
    memo: string,
  ): Promise<{ footprint: string; minResourceFee: string }> {
    if (!this.contractId) {
      return { footprint: 'not_configured', minResourceFee: '0' };
    }

    try {
      const contract = new Contract(this.contractId);
      const amountBigInt = BigInt(amount);

      const op = contract.call(
        functionName,
        Address.fromString(sourceAddress).toScVal(),
        Address.fromString(targetAddress).toScVal(),
        Address.fromString(tokenAddress).toScVal(),
        xdr.ScVal.scvI128(
          new xdr.Int128Parts({
            lo: new xdr.Uint64(amountBigInt & BigInt('0xFFFFFFFFFFFFFFFF')),
            hi: new xdr.Int64(amountBigInt >> BigInt(64)),
          }),
        ),
        xdr.ScVal.scvBytes(Buffer.from(memo || '')),
      );

      // Build a minimal transaction for simulation purposes.
      // The source is a throwaway keypair — the RPC simulates without verifying signatures.
      const dummyKeypair = Keypair.random();
      const dummyAccount = new Account(dummyKeypair.publicKey(), '0');

      const tx = new TransactionBuilder(dummyAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(30)
        .build();

      const simulation = await rpcPool.execute((server) =>
        server.simulateTransaction(tx),
      );

      if ('error' in simulation && simulation.error) {
        return { footprint: 'error', minResourceFee: '0' };
      }

      if ('transactionData' in simulation && simulation.transactionData) {
        const footprint = simulation.transactionData.build().toXDR('base64');
        const minResourceFee = simulation.minResourceFee || '0';
        return { footprint, minResourceFee };
      }

      return { footprint: 'pending', minResourceFee: '0' };
    } catch (err) {
      logger.error({ err: String(err) }, 'contract simulation failed');
      return { footprint: 'simulation_failed', minResourceFee: '0' };
    }
  }

  getRpcMetrics(): Array<{ url: string; healthy: boolean; consecutiveFailures: number; lastFailureAt: number | null; lastLatencyMs: number | null; totalRequests: number; totalFailures: number }> {
    return rpcPool.getMetrics();
  }
}

export const sorobanService = new SorobanService();
