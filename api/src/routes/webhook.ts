import { Router, Request, Response } from 'express';
import { moonpayService } from '../services/moonpay';

/** Express router for MoonPay webhook callbacks. Mounted at `/api/webhook/moonpay`. */
export const moonpayWebhookRouter = Router();

moonpayWebhookRouter.post('/', (req: Request, res: Response) => {
  const signature = req.headers['x-moonpay-signature'] as string | undefined;
  if (!signature) {
    res.status(400).json({ error: 'missing signature header' });
    return;
  }

  const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const isValid = moonpayService.verifyWebhookSignature(payload, signature);
  if (!isValid) {
    res.status(401).json({ error: 'invalid signature' });
    return;
  }
  res.json({ status: 'ok' });
});
