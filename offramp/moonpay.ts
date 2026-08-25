import crypto from 'crypto';

/** MoonPay API credentials. */
export interface MoonpayConfig {
  apiKey: string;
  secretKey: string;
}

/** Parameters for building a MoonPay widget URL. */
export interface MoonpayPurchaseParams {
  walletAddress: string;
  walletNetwork: string;
  currencyCode?: string;
  baseCurrency?: string;
  baseCurrencyAmount?: number;
  email?: string;
  redirectUrl?: string;
}

/**
 * Builds a MoonPay widget URL for purchasing crypto directly to a Stellar address.
 *
 * @param config - MoonPay API credentials.
 * @param params - Widget configuration.
 * @returns Fully-formed URL to open in a browser or WebView.
 */
export function createMoonpayWidgetUrl(config: MoonpayConfig, params: MoonpayPurchaseParams): string {
  const query = new URLSearchParams({
    apiKey: config.apiKey,
    walletAddress: params.walletAddress,
    walletNetwork: params.walletNetwork,
    currencyCode: params.currencyCode ?? 'xlm',
  });

  if (params.baseCurrency) query.set('baseCurrency', params.baseCurrency);
  if (params.baseCurrencyAmount) query.set('baseCurrencyAmount', params.baseCurrencyAmount.toString());
  if (params.email) query.set('email', params.email);
  if (params.redirectUrl) query.set('redirectURL', params.redirectUrl);

  return `https://buy.moonpay.com?${query.toString()}`;
}

  baseCurrencyAmount: number;
  quoteCurrency: string;
}): Promise<{
  quoteCurrencyAmount: number;
  feeAmount: number;
  totalAmount: number;
}> {
  const url = `https://api.moonpay.com/v3/currencies/${params.quoteCurrency}/buy_quote`;
  const query = new URLSearchParams({
    apiKey: config.apiKey,
    baseCurrencyAmount: params.baseCurrencyAmount.toString(),
    baseCurrency: params.baseCurrency,
    areFeesIncluded: 'true',
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let res: Response;
  try {
    res = await fetch(`${url}?${query.toString()}`, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new Error(`moonpay quote failed: ${res.statusText}`);

  const data = await res.json();
  const { quoteCurrencyAmount, feeAmount, totalAmount } = data ?? {};
  if (
    typeof quoteCurrencyAmount !== 'number'
    || typeof feeAmount !== 'number'
    || typeof totalAmount !== 'number'
  ) {
    throw new Error('moonpay quote response missing expected numeric fields');
  }

  return { quoteCurrencyAmount, feeAmount, totalAmount };
}
