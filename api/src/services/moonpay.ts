import { createHmac } from 'crypto';
import { config } from '../config';
import { getCircuitBreaker } from '../circuit-breaker';

interface MoonpayWidgetParams {
  apiKey: string;
  currencyCode: string;
  walletAddress: string;
  walletNetwork: string;
  baseCurrencyAmount?: number;
  baseCurrencyCode?: string;
  email?: string;
}

/** Handles MoonPay widget URL generation. */
export class MoonpayService {
  private apiKey: string;
  private secretKey: string;
  private sandbox: boolean;

  constructor() {
    this.apiKey = config.moonpay.apiKey;
    this.secretKey = config.moonpay.secretKey;
    this.sandbox = Boolean(config.moonpay.sandbox);
  }

  /**
   * Signs a MoonPay query string as documented: base64(HMAC_SHA256(secretKey, '?' + query)).
   *
   * @param query - The URL-encoded query string (without the leading `?`).
   * @returns Base64-encoded signature.
   */
  private signQuery(query: string): string {
    return createHmac('sha256', this.secretKey)
      .update(`?${query}`)
      .digest('base64');
  }

  /**
   * Builds a signed MoonPay widget URL for the given parameters.
   *
   * @param params - Widget configuration; `apiKey` is injected automatically.
   * @returns Fully-formed URL to open in a browser or WebView.
   */
  generateWidgetUrl(params: Omit<MoonpayWidgetParams, 'apiKey'>): string {
    const queryParams = new URLSearchParams({
      apiKey: this.apiKey,
      currencyCode: params.currencyCode,
      walletAddress: params.walletAddress,
      walletNetwork: params.walletNetwork,
    });

    if (params.baseCurrencyAmount) {
      queryParams.set('baseCurrencyAmount', params.baseCurrencyAmount.toString());
    }
    if (params.baseCurrencyCode) {
      queryParams.set('baseCurrencyCode', params.baseCurrencyCode);
    }
    if (params.email) {
      queryParams.set('email', params.email);
    }

    const query = queryParams.toString();
    const signature = this.signQuery(query);
    const baseUrl = this.sandbox
      ? 'https://buy-sandbox.moonpay.com'
      : 'https://buy.moonpay.com';
    return `${baseUrl}?${query}&signature=${encodeURIComponent(signature)}`;
  }

  /**
   * Fetches a real-time buy quote from the MoonPay API.
   *
   * @param params - Base currency, amount, and quote currency.
   * @returns Quote amounts and fees from MoonPay.
   * @throws {Error} If the request times out, MoonPay returns a non-2xx response,
   * or the response is missing expected numeric fields.
   */
  async getBuyQuote(params: {
    baseCurrency: string;
    baseCurrencyAmount: number;
    quoteCurrency: string;
  }): Promise<{
    quoteCurrencyAmount: number;
    feeAmount: number;
    totalAmount: number;
  }> {
    const url = `https://api.moonpay.com/v3/currencies/${params.quoteCurrency}/buy_quote`;
    const query = new URLSearchParams({
      apiKey: this.apiKey,
      baseCurrencyAmount: params.baseCurrencyAmount.toString(),
      baseCurrency: params.baseCurrency,
      areFeesIncluded: 'true',
    });

    // Network errors and 5xx responses count towards the breaker; 4xx do not.
    const res = await getCircuitBreaker('moonpay').execute(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(`${url}?${query.toString()}`, { signal: controller.signal });
        if (response.status >= 500) throw new Error(`moonpay quote failed: ${response.statusText}`);
        return response;
      } finally {
        clearTimeout(timeout);
      }
    });

    if (!res.ok) throw new Error(`moonpay quote failed: ${res.statusText}`);

    // res.json() is untyped; the runtime guards immediately below are what
    // actually validate the shape.
    const data = (await res.json()) as Record<string, unknown> | null;
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
}

export const moonpayService = new MoonpayService();
