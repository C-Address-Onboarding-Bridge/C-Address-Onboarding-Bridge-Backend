import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { STELLAR_ADDRESS_REGEX } from '../utils/constants';
import { moonpayService } from '../services/moonpay';
import { transakService } from '../services/transak';
import { onrampRequestCount } from '../services/metrics';
import { enqueueCounterIncrement } from '../services/asyncPipeline';

/** Express router for off-ramp widget URL generation. Mounted at `/api/v1/offramp`. */
export const offrampRouter = Router();

const moonpaySchema = z.object({
  currencyCode: z.string().default('xlm'),
  walletAddress: z.string().regex(STELLAR_ADDRESS_REGEX, 'invalid Stellar address'),
  walletNetwork: z.string().default('stellar'),
  baseCurrencyAmount: z.number().positive().optional(),
  baseCurrencyCode: z.string().optional(),
  email: z.string().email().optional(),
});

const moonpayQuoteSchema = z.object({
  baseCurrency: z.string().min(1),
  baseCurrencyAmount: z.coerce.number().positive(),
  quoteCurrency: z.string().min(1).default('xlm'),
});

const transakSchema = z.object({
  walletAddress: z.string().regex(STELLAR_ADDRESS_REGEX, 'invalid Stellar address'),
  network: z.string().default('stellar'),
  fiatCurrency: z.string().optional(),
  cryptoCurrency: z.string().optional(),
  fiatAmount: z.number().positive().optional(),
  email: z.string().email().optional(),
  redirectURL: z.string().optional(),
});

offrampRouter.post('/moonpay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = moonpaySchema.parse(req.body);
    const url = moonpayService.generateWidgetUrl(params);
    // Counter increment is best-effort; falls back to sync if pipeline is disabled.
    enqueueCounterIncrement(
      'onramp_request',
      { provider: 'moonpay', status: 'success' },
      () => onrampRequestCount.inc({ provider: 'moonpay', status: 'success' }),
    );
    res.json({ url });
  } catch (err) {
    enqueueCounterIncrement(
      'onramp_request',
      { provider: 'moonpay', status: 'failed' },
      () => onrampRequestCount.inc({ provider: 'moonpay', status: 'failed' }),
    );
    next(err);
  }
});

offrampRouter.get('/moonpay/quote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = moonpayQuoteSchema.parse(req.query);
    const quote = await moonpayService.getBuyQuote(params);
    res.json(quote);
  } catch (err) {
    next(err);
  }
});

offrampRouter.post('/transak', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = transakSchema.parse(req.body);
    const url = transakService.generateWidgetUrl(params);
    enqueueCounterIncrement(
      'onramp_request',
      { provider: 'transak', status: 'success' },
      () => onrampRequestCount.inc({ provider: 'transak', status: 'success' }),
    );
    res.json({ url });
  } catch (err) {
    enqueueCounterIncrement(
      'onramp_request',
      { provider: 'transak', status: 'failed' },
      () => onrampRequestCount.inc({ provider: 'transak', status: 'failed' }),
    );
    next(err);
  }
});
