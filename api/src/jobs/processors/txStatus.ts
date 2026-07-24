import { Job } from 'bullmq';
import { TxStatusPollData } from '../queue';
import { sorobanService } from '../../services/soroban';
import { eventBroker } from '../../services/eventBroker';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export async function processTxStatusPoll(job: Job<TxStatusPollData>): Promise<void> {
  const { txHash } = job.data;
  logger.info({ txHash, attempt: job.attemptsMade }, 'polling tx status');

  const status = await sorobanService.getTransactionStatus(txHash);
  logger.info({ txHash, status: status.status }, 'tx status polled');

  if (status.status === 'pending') {
    throw new Error(`tx ${txHash} still pending`);
  }

  // Retrieve original transaction request details
  const orig = await eventBroker.getEventByTxHash(txHash);

  if (status.status === 'success') {
    await eventBroker.publish({
      type: 'FundingCompleted',
      data: {
        txHash,
        sourceAddress: orig?.sourceAddress || '',
        targetAddress: orig?.targetAddress || '',
        tokenAddress: orig?.tokenAddress || '',
        amount: orig?.amount || '0',
        feeBps: orig?.feeBps || 30,
        completedAt: Date.now(),
      },
    });
  } else if (status.status === 'failed') {
    await eventBroker.publish({
      type: 'FundingFailed',
      data: {
        txHash,
        sourceAddress: orig?.sourceAddress,
        targetAddress: orig?.targetAddress,
        tokenAddress: orig?.tokenAddress,
        amount: orig?.amount,
        error: status.error || 'transaction failed',
        failedAt: Date.now(),
      },
    });
  }
}
