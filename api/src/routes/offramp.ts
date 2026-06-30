import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { moonpayService } from '../services/moonpay';
import { transakService } from '../services/transak';
import { onrampRequestCount } from '../services/metrics';

/** Express router for off-ramp widget URL generation. Mounted at `/api/v1/offramp`. */
export const offrampRouter = Router();

const stellarAddressRegex = /^[GC][A-Z2-7]{55}$/;

const moonpaySchema = z.object({
  currencyCode: z.string().default('xlm'),
  walletAddress: z.string().regex(stellarAddressRegex, 'invalid Stellar address'),
  walletNetwork: z.string().default('stellar'),
  baseCurrencyAmount: z.number().positive().optional(),
  baseCurrencyCode: z.string().optional(),
  email: z.string().email().optional(),
});

const transakSchema = z.object({
  walletAddress: z.string().regex(stellarAddressRegex, 'invalid Stellar address'),
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
    onrampRequestCount.inc({ provider: 'moonpay', status: 'success' });
    res.json({ url });
  } catch (err) {
    onrampRequestCount.inc({ provider: 'moonpay', status: 'failed' });
    next(err);
  }
});

offrampRouter.post('/transak', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = transakSchema.parse(req.body);
    const url = transakService.generateWidgetUrl(params);
    onrampRequestCount.inc({ provider: 'transak', status: 'success' });
    res.json({ url });
  } catch (err) {
    onrampRequestCount.inc({ provider: 'transak', status: 'failed' });
    next(err);
  }
});
