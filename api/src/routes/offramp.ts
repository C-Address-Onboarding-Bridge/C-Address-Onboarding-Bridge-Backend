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
  partnerFee: z.number().positive().optional(),
  themeColor: z.string().optional(),
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

const quoteRequestSchema = z.object({
  fiatAmount: z.coerce.number().positive(),
  fiatCurrency: z.string().min(1),
  cryptoCurrency: z.string().min(1).default('xlm'),
  cAddress: z.string().regex(STELLAR_ADDRESS_REGEX, 'invalid Stellar address'),
});

interface ProviderQuote {
  provider: 'moonpay' | 'transak';
  fiatAmount: number;
  cryptoAmount: number;
  feeAmount: number;
  netAmount: number;
  estimatedRate: number;
}

offrampRouter.get('/quote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = quoteRequestSchema.parse(req.query);

    const [moonpayResult, transakResult] = await Promise.allSettled([
      (async () => {
        const quote = await moonpayService.getBuyQuote({
          baseCurrency: params.fiatCurrency,
          baseCurrencyAmount: params.fiatAmount,
          quoteCurrency: params.cryptoCurrency,
        });
        return {
          provider: 'moonpay' as const,
          fiatAmount: params.fiatAmount,
          cryptoAmount: quote.quoteCurrencyAmount,
          feeAmount: quote.feeAmount,
          netAmount: quote.quoteCurrencyAmount,
          estimatedRate: quote.quoteCurrencyAmount / params.fiatAmount,
        };
      })(),
      (async () => {
        const quote = await transakService.getBuyQuote({
          fiatCurrency: params.fiatCurrency,
          fiatAmount: params.fiatAmount,
          cryptoCurrency: params.cryptoCurrency,
        });
        return {
          provider: 'transak' as const,
          fiatAmount: params.fiatAmount,
          cryptoAmount: quote.cryptoAmount,
          feeAmount: quote.feeAmount,
          netAmount: quote.cryptoAmount - quote.feeAmount,
          estimatedRate: quote.cryptoAmount / params.fiatAmount,
        };
      })(),
    ]);

    const quotes: ProviderQuote[] = [];
    const errors: Array<{ provider: string; error: string }> = [];

    if (moonpayResult.status === 'fulfilled') {
      quotes.push(moonpayResult.value);
    } else if (moonpayResult.reason instanceof Error) {
      errors.push({ provider: 'moonpay', error: moonpayResult.reason.message });
    }

    if (transakResult.status === 'fulfilled') {
      quotes.push(transakResult.value);
    } else if (transakResult.reason instanceof Error) {
      errors.push({ provider: 'transak', error: transakResult.reason.message });
    }

    if (quotes.length === 0) {
      res.status(503).json({
        error: 'no_quotes_available',
        message: 'Unable to fetch quotes from any provider',
        errors,
      });
      return;
    }

    // Sort by net amount in descending order (best first)
    const sorted = quotes.sort((a, b) => b.netAmount - a.netAmount);
    const best = sorted[0];

    enqueueCounterIncrement(
      'onramp_quote',
      { provider: best.provider, status: 'success' },
      () => onrampRequestCount.inc({ provider: best.provider, status: 'success' }),
    );

    res.json({
      best,
      alternatives: sorted.slice(1),
      comparison: sorted,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    enqueueCounterIncrement(
      'onramp_quote',
      { provider: 'unknown', status: 'failed' },
      () => onrampRequestCount.inc({ provider: 'unknown', status: 'failed' }),
    );
    next(err);
  }
});
