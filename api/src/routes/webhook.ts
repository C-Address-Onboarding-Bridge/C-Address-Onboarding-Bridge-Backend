import { Router, Request, Response } from 'express';
import { verifyMoonpayWebhook, verifyTransakWebhook } from '../middleware/webhookVerification';
import { logger } from '../index';
import { eventBroker } from '../services/eventBroker';

export const moonpayWebhookRouter = Router();
export const transakWebhookRouter = Router();

moonpayWebhookRouter.post('/', verifyMoonpayWebhook, async (req: Request, res: Response) => {
  try {
    logger.info({ path: req.path }, 'moonpay webhook received and verified');
    const body = req.body ? JSON.parse(req.body as string) : {};
    
    await eventBroker.publish({
      type: 'WebhookReceived',
      data: {
        provider: 'moonpay',
        payload: body,
        receivedAt: Date.now(),
      },
    });

    res.json({ status: 'ok' });
  } catch (err) {
    logger.error({ err }, 'moonpay webhook processing error');
    res.status(500).json({ error: 'internal_error' });
  }
});

transakWebhookRouter.post('/', verifyTransakWebhook, async (req: Request, res: Response) => {
  try {
    logger.info({ path: req.path }, 'transak webhook received and verified');
    const body = req.body ? JSON.parse(req.body as string) : {};

    await eventBroker.publish({
      type: 'WebhookReceived',
      data: {
        provider: 'transak',
        payload: body,
        receivedAt: Date.now(),
      },
    });

    res.json({ status: 'ok' });
  } catch (err) {
    logger.error({ err }, 'transak webhook processing error');
    res.status(500).json({ error: 'internal_error' });
  }
});
