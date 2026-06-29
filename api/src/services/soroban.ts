import {
  Transaction,
  xdr,
} from '@stellar/stellar-sdk';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { config } from '../config';
import { rpcPool } from './rpcPool';
import { externalCallDuration } from './metrics';

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
   * Submits a signed Soroban transaction XDR to the network.
   *
   * @param signedXdr - Base64-encoded signed transaction envelope.
   * @returns Transaction status and hash.
   */
  async submitFundingTransaction(
    signedXdr: string,
  ): Promise<SorobanTxResponse> {
    return tracer.startActiveSpan('soroban.submitFundingTransaction', async (span): Promise<SorobanTxResponse> => {
      const start = Date.now();
      try {
        const envelope = xdr.TransactionEnvelope.fromXDR(signedXdr, 'base64');
        const tx = new Transaction(envelope, this.networkPassphrase);
        const txHash = tx.hash().toString('hex');
        span.setAttribute('tx.hash', txHash);

        const sendResponse = await rpcPool.execute((server) => server.sendTransaction(tx));
        externalCallDuration.observe({ service: 'soroban' }, (Date.now() - start) / 1000);

        if (sendResponse.status === 'PENDING') {
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
        return { status: 'success' as const, hash: txHash };
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
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
   * Currently a stub — returns placeholder values until Soroban simulation is wired up.
   *
   * @param _sourceAddress - Signing account address.
   * @param _functionName - Contract function to simulate.
   */
  async contractSimulate(
    _sourceAddress: string,
    _functionName: string,
  ): Promise<{ footprint: string; minResourceFee: string }> {
    // TODO: implement Soroban simulation using SorobanRpc.Server.simulateTransaction.
    // Should build the contract invocation, simulate it, and return the real footprint
    // and minResourceFee so the caller can construct a properly-budgeted transaction.
    if (!this.contractId) {
      return { footprint: 'not_configured', minResourceFee: '0' };
    }
    return { footprint: 'pending', minResourceFee: '0' };
  }

  getRpcMetrics(): Array<{ url: string; healthy: boolean; consecutiveFailures: number; lastFailureAt: number | null; lastLatencyMs: number | null; totalRequests: number; totalFailures: number }> {
    return rpcPool.getMetrics();
  }
}

export const sorobanService = new SorobanService();
