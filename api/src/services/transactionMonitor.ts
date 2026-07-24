import { eventBroker, FundingRequestedEvent } from './eventBroker';
import { sorobanService } from './soroban';
import { logger } from '../logger';
import { enqueueTxStatusPoll } from '../jobs/queue';
import { xdr, Transaction, Address, FeeBumpTransaction } from '@stellar/stellar-sdk';
import { config } from '../config';

export interface ParsedXdrDetails {
  functionName: string;
  sourceAddress: string;
  targetAddress: string;
  tokenAddress: string;
  amount: string;
  memo?: string;
}

export function parseXdrDetails(signedXdr: string): ParsedXdrDetails {
  const envelope = xdr.TransactionEnvelope.fromXDR(signedXdr, 'base64');
  let tx: Transaction;
  const inner = new Transaction(envelope, config.soroban.networkPassphrase);
  if (inner instanceof FeeBumpTransaction) {
    tx = inner.innerTransaction;
  } else {
    tx = inner;
  }

  const op = tx.operations.find((o) => o.type === 'invokeHostFunction');
  if (!op || op.type !== 'invokeHostFunction') {
    throw new Error('No InvokeHostFunction operation found in transaction');
  }

  const hf = (op as any).func as xdr.HostFunction;
  if (!hf || hf.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    throw new Error('Operation is not an invokeContract host function');
  }

  const invokeArgs = hf.invokeContract();
  const functionName = invokeArgs.functionName().toString();
  const args = invokeArgs.args();

  let sourceAddress = tx.source;
  let targetAddress = '';
  let tokenAddress = '';
  let amount = '0';
  let memo = '';

  if (functionName === 'fund_c_address') {
    if (args.length >= 4) {
      sourceAddress = Address.fromScVal(args[0]).toString();
      targetAddress = Address.fromScVal(args[1]).toString();
      tokenAddress = Address.fromScVal(args[2]).toString();
      
      const parts = args[3].i128();
      const hi = BigInt(parts.hi().toString());
      const lo = BigInt(parts.lo().toString());
      amount = ((hi << 64n) | lo).toString();

      if (args.length >= 5 && args[4].switch() === xdr.ScValType.scvBytes()) {
        memo = args[4].bytes().toString('utf8');
      }
    }
  } else if (functionName === 'route_from_exchange') {
    if (args.length >= 4) {
      sourceAddress = args[0].sym()?.toString() || 'exchange';
      targetAddress = Address.fromScVal(args[1]).toString();
      tokenAddress = Address.fromScVal(args[2]).toString();

      const parts = args[3].i128();
      const hi = BigInt(parts.hi().toString());
      const lo = BigInt(parts.lo().toString());
      amount = ((hi << 64n) | lo).toString();

      if (args.length >= 5 && args[4].switch() === xdr.ScValType.scvBytes()) {
        memo = args[4].bytes().toString('utf8');
      }
    }
  } else if (functionName === 'withdraw_fees') {
    if (args.length >= 3) {
      targetAddress = Address.fromScVal(args[0]).toString();
      tokenAddress = Address.fromScVal(args[1]).toString();

      const parts = args[2].i128();
      const hi = BigInt(parts.hi().toString());
      const lo = BigInt(parts.lo().toString());
      amount = ((hi << 64n) | lo).toString();
    }
  }

  return {
    functionName,
    sourceAddress,
    targetAddress,
    tokenAddress,
    amount,
    memo,
  };
}

export class TransactionMonitor {
  start() {
    eventBroker.subscribe('FundingRequested', async (event: FundingRequestedEvent) => {
      logger.info({ txHash: event.txHash }, 'TransactionMonitor: processing FundingRequested');

      try {
        const result = await sorobanService.submitFundingTransaction(event.signedXdr);
        logger.info({ txHash: event.txHash, status: result.status }, 'TransactionMonitor: Soroban RPC submit outcome');

        if (result.status === 'success') {
          await eventBroker.publish({
            type: 'FundingCompleted',
            data: {
              txHash: event.txHash,
              sourceAddress: event.sourceAddress,
              targetAddress: event.targetAddress,
              tokenAddress: event.tokenAddress,
              amount: event.amount,
              feeBps: event.feeBps,
              completedAt: Date.now(),
            },
          });
        } else if (result.status === 'failed') {
          await eventBroker.publish({
            type: 'FundingFailed',
            data: {
              txHash: event.txHash,
              sourceAddress: event.sourceAddress,
              targetAddress: event.targetAddress,
              tokenAddress: event.tokenAddress,
              amount: event.amount,
              error: result.error || 'submission failed',
              failedAt: Date.now(),
            },
          });
        } else {
          // status is 'pending'
          await enqueueTxStatusPoll(event.txHash);
        }
      } catch (err: any) {
        logger.error({ txHash: event.txHash, err: err.message }, 'TransactionMonitor: Soroban RPC submission error');
        await eventBroker.publish({
          type: 'FundingFailed',
          data: {
            txHash: event.txHash,
            sourceAddress: event.sourceAddress,
            targetAddress: event.targetAddress,
            tokenAddress: event.tokenAddress,
            amount: event.amount,
            error: err.message || 'submission rejected',
            failedAt: Date.now(),
          },
        });
      }
    });
  }
}

export const transactionMonitor = new TransactionMonitor();
