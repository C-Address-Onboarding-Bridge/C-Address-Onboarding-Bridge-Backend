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
  const query = new URLSearchParams();
  query.set('apiKey', config.apiKey);
  query.set('walletAddress', params.walletAddress);
  query.set('walletNetwork', params.walletNetwork);
  if (params.currencyCode !== undefined) query.set('currencyCode', params.currencyCode);
  if (params.baseCurrency !== undefined) query.set('baseCurrency', params.baseCurrency);
  if (params.baseCurrencyAmount !== undefined) query.set('baseCurrencyAmount', String(params.baseCurrencyAmount));
  if (params.email !== undefined) query.set('email', params.email);
  if (params.redirectUrl !== undefined) query.set('redirectUrl', params.redirectUrl);

  const queryString = `?${query.toString()}`;

  const signature = crypto
    .createHmac('sha256', config.secretKey)
    .update(queryString)
    .digest('base64');

  return `https://buy.moonpay.com${queryString}&signature=${encodeURIComponent(signature)}`;
}

/**
 * Verifies a MoonPay webhook HMAC-SHA256 signature.
 *
 * @param config - MoonPay credentials (only `secretKey` is used).
 * @param rawBody - Raw request body string received from MoonPay.
 * @param signature - Value of the `x-moonpay-signature` header (hex).
 * @returns `true` when the signature matches, `false` otherwise (including
 * when the signature has a different byte length than the computed HMAC).
 */
export function verifyMoonpayWebhook(config: MoonpayConfig, rawBody: string, signature: string): boolean {
  const computed = crypto
    .createHmac('sha256', config.secretKey)
    .update(rawBody)
    .digest('hex');

  if (computed.length !== signature.length) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Fetches a real-time buy quote from the MoonPay API.
 *
 * @param config - MoonPay API credentials.
 * @param params - Base currency, amount, and quote currency.
 * @returns Quote amounts and fees from MoonPay.
 * @throws {Error} If the MoonPay API returns a non-2xx response.
 */
export async function getMoonpayBuyQuote(config: MoonpayConfig, params: {
  baseCurrency: string;
  baseCurrencyAmount: number;
  quoteCurrency: string;
}): Promise<{ quoteCurrencyAmount: number; feeAmount: number; totalAmount: number }> {
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
