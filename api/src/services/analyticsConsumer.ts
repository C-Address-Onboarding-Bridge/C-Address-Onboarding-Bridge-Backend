import { eventBroker } from './eventBroker';
import { recordFundingMetrics } from './metrics';
import { logger } from '../logger';

export class AnalyticsConsumer {
  start() {
    // 1. FundingRequested -> status: pending
    eventBroker.subscribe('FundingRequested', async (event) => {
      logger.info({ txHash: event.txHash }, 'AnalyticsConsumer: processing FundingRequested');
      
      const amountNum = BigInt(event.amount);
      const feeAmount = (amountNum * BigInt(event.feeBps)) / 10000n;

      recordFundingMetrics({
        source: 'api',
        status: 'pending',
        amountStroops: event.amount,
        feeStroops: feeAmount.toString(),
        currency: 'XLM',
      });
    });

    // 2. FundingCompleted -> status: success
    eventBroker.subscribe('FundingCompleted', async (event) => {
      logger.info({ txHash: event.txHash }, 'AnalyticsConsumer: processing FundingCompleted');
      
      const amountNum = BigInt(event.amount);
      const feeAmount = event.fee || ((amountNum * BigInt(event.feeBps)) / 10000n).toString();

      recordFundingMetrics({
        source: 'api',
        status: 'success',
        amountStroops: event.amount,
        feeStroops: feeAmount,
        currency: 'XLM',
      });
    });

    // 3. FundingFailed -> status: failed
    eventBroker.subscribe('FundingFailed', async (event) => {
      logger.info({ txHash: event.txHash }, 'AnalyticsConsumer: processing FundingFailed');
      
      recordFundingMetrics({
        source: 'api',
        status: 'failed',
        amountStroops: event.amount,
        currency: 'XLM',
      });
    });
  }
}

export const analyticsConsumer = new AnalyticsConsumer();
