import { eventBroker } from './eventBroker';
import { invalidateStatusCache } from '../routes/status';
import { webhookDeliveryService } from './webhookDelivery';
import { logger } from '../logger';

export class WebhookDispatcher {
  start() {
    // 1. WebhookReceived -> Invalidate Status Cache
    eventBroker.subscribe('WebhookReceived', async (event) => {
      logger.info({ provider: event.provider }, 'WebhookDispatcher: processing WebhookReceived');

      try {
        const payload = event.payload || {};
        const txId = payload.data?.id || payload.id || payload.data?.externalTransactionId;

        if (txId) {
          logger.info({ txId }, 'WebhookDispatcher: invalidating status cache');
          await invalidateStatusCache(txId);
        }

        // Deliver generic webhook notifications to registrations matching the api key
        const apiKey = payload.apiKey || 'api-key';
        await webhookDeliveryService.deliverToAll(apiKey, 'webhook.received', {
          provider: event.provider,
          payload,
          receivedAt: event.receivedAt,
        });
      } catch (err: any) {
        logger.error({ err: err.message }, 'WebhookDispatcher error processing WebhookReceived');
      }
    });

    // 2. FundingCompleted -> Deliver Webhook to Registrations
    eventBroker.subscribe('FundingCompleted', async (event) => {
      logger.info({ txHash: event.txHash }, 'WebhookDispatcher: processing FundingCompleted');

      try {
        const originalReq = await eventBroker.getEventByTxHash(event.txHash);
        const apiKey = originalReq?.signedXdr ? 'api-key' : 'api-key'; // default/fallback

        // Deliver webhook notification to all registered integrations for this API key
        await webhookDeliveryService.deliverToAll(apiKey, 'funding.completed', {
          txHash: event.txHash,
          sourceAddress: event.sourceAddress,
          targetAddress: event.targetAddress,
          amount: event.amount,
          fee: event.fee,
          completedAt: event.completedAt,
        });
      } catch (err: any) {
        logger.error({ txHash: event.txHash, err: err.message }, 'WebhookDispatcher error processing FundingCompleted');
      }
    });

    // 3. FundingFailed -> Deliver Webhook to Registrations
    eventBroker.subscribe('FundingFailed', async (event) => {
      logger.info({ txHash: event.txHash }, 'WebhookDispatcher: processing FundingFailed');

      try {
        const originalReq = await eventBroker.getEventByTxHash(event.txHash);
        const apiKey = originalReq?.signedXdr ? 'api-key' : 'api-key';

        await webhookDeliveryService.deliverToAll(apiKey, 'funding.failed', {
          txHash: event.txHash,
          error: event.error,
          failedAt: event.failedAt,
        });
      } catch (err: any) {
        logger.error({ txHash: event.txHash, err: err.message }, 'WebhookDispatcher error processing FundingFailed');
      }
    });
  }
}

export const webhookDispatcher = new WebhookDispatcher();
