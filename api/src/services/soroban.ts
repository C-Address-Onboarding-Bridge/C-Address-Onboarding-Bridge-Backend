import {
  Transaction,
  xdr,
} from '@stellar/stellar-sdk';
import { config } from '../config';
import { rpcPool } from './rpcPool';

export interface SorobanTxResponse {
  status: 'pending' | 'success' | 'failed';
  hash: string;
  error?: string;
}

const BASIS_POINTS_DENOM = 10000;

export class SorobanService {
  private networkPassphrase: string;
  private contractId: string;

  constructor() {
    this.networkPassphrase = config.soroban.networkPassphrase;
    this.contractId = config.soroban.bridgeContractId;
  }

  async getQuote(
    sourceAsset: string,
    amount: string,
    _targetAddress: string,
  ): Promise<{
    estimatedFee: string;
    expectedReceive: string;
    feeBps: number;
    rate: string;
  }> {
    const feeBps = config.soroban.feeBps;
    const amountNum = BigInt(amount);
    const feeAmount = (amountNum * BigInt(feeBps)) / BigInt(BASIS_POINTS_DENOM);
    const receiveAmount = amountNum - feeAmount;

    return {
      estimatedFee: feeAmount.toString(),
      expectedReceive: receiveAmount.toString(),
      feeBps,
      rate: '1.0',
    };
  }

  async submitFundingTransaction(
    signedXdr: string,
  ): Promise<SorobanTxResponse> {
    const envelope = xdr.TransactionEnvelope.fromXDR(signedXdr, 'base64');
    const tx = new Transaction(envelope, this.networkPassphrase);
    const txHash = tx.hash().toString('hex');

    const sendResponse = await rpcPool.execute((server) => server.sendTransaction(tx));

    if (sendResponse.status === 'PENDING') {
      return { status: 'pending', hash: txHash };
    }
    if (sendResponse.status === 'ERROR') {
      return {
        status: 'failed',
        hash: txHash,
        error: sendResponse.errorResult?.result().toString() || 'unknown error',
      };
    }
    return { status: 'success', hash: txHash };
  }

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
      return { status: 'pending', hash: txHash };
    }
  }

  async contractSimulate(
    _sourceAddress: string,
    _functionName: string,
  ): Promise<{ footprint: string; minResourceFee: string }> {
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
