import crypto from 'crypto';

/** MoonPay API credentials. */
export interface MoonpayConfig {
  apiKey: string;
  secretKey: string;
  /** Dedicated webhook signing key (separate from secretKey). */
  webhookKey?: string;
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
  const query = new URLSearchParams({ apiKey: config.apiKey });

  if (params.walletAddress) query.set('walletAddress', params.walletAddress);
  if (params.walletNetwork) query.set('walletNetwork', params.walletNetwork);
  if (params.currencyCode) query.set('currencyCode', params.currencyCode);
  if (params.baseCurrency) query.set('baseCurrencyCode', params.baseCurrency);
  if (params.baseCurrencyAmount != null) query.set('baseCurrencyAmount', String(params.baseCurrencyAmount));
  if (params.email) query.set('email', params.email);
  if (params.redirectUrl) query.set('redirectUrl', params.redirectUrl);

  const queryString = `?${query.toString()}`;

  const signature = crypto
    .createHmac('sha256', config.secretKey)
    .update(queryString)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `https://buy.moonpay.com${queryString}&signature=${signature}`;
}

/**
 * Verifies a MoonPay V2 webhook signature.
 *
 * MoonPay signs webhooks with the `Moonpay-Signature-V2` header formatted as:
 *   `t=<unix-timestamp-ms>,s=<hex-encoded-hmac-sha256>`
 * The HMAC covers `${timestamp}.${rawBody}` using the dedicated `webhookKey`.
 *
 * @param config - MoonPay credentials. `webhookKey` is used when present,
 *   otherwise falls back to `secretKey` for backward compatibility.
 * @param rawBody - Raw request body string exactly as received.
 * @param signature - Value of the `Moonpay-Signature-V2` header.
 * @param toleranceMs - Maximum age of the timestamp in milliseconds (default 5 min).
 * @returns `true` when the signature is valid and the timestamp is fresh.
 */
export function verifyMoonpayWebhook(
  config: MoonpayConfig,
  rawBody: string,
  signature: string,
  toleranceMs = 5 * 60 * 1000,
): boolean {
  if (typeof signature !== 'string' || !signature.includes(',')) return false;

  const parts = signature.split(',');
  let timestamp: string | undefined;
  let hmacHex: string | undefined;

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) return false;
    const k = part.slice(0, eqIdx).trim();
    const v = part.slice(eqIdx + 1).trim();
    if (k === 't') timestamp = v;
    else if (k === 's') hmacHex = v;
  }

  if (!timestamp || !hmacHex) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;

  // Reject stale timestamps
  if (Math.abs(Date.now() - ts) > toleranceMs) return false;

  const signingKey = config.webhookKey ?? config.secretKey;
  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', signingKey)
    .update(payload)
    .digest('hex');

  if (expected.length !== hmacHex.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hmacHex, 'hex'));
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
}): Promise<{
  // Restored from d2a6c17^. The "seed learning exercises" stubbing pass wrote
  // its `throw new Error('Not implemented')` into this *return type* instead of
  // the function body -- a parse error that broke every test importing this
  // module. The body below was already implemented and is untouched.
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
