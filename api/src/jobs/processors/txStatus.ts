import { Job } from 'bullmq';
import { TxStatusPollData } from '../queue';
import { sorobanService } from '../../services/soroban';
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
}
