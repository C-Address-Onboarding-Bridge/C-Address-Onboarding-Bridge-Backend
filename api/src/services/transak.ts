import { config } from '../config';

interface TransakWidgetParams {
  apiKey: string;
  walletAddress: string;
  network: string;
  fiatCurrency?: string;
  cryptoCurrency?: string;
  fiatAmount?: number;
  email?: string;
  redirectURL?: string;
  /** Optional partner fee percentage to display in the widget. */
  partnerFee?: number;
  /** Widget branding color (hex). Defaults to the standard bridge brand color. */
  themeColor?: string;
}

/** Handles Transak widget URL generation for fiat on-ramp flows. */
export class TransakService {
  private apiKey: string;
  private environment: string;

  constructor() {
    this.apiKey = config.transak.apiKey;
    this.environment = config.transak.environment;
  }

  /**
   * Builds a Transak widget URL for the given parameters.
   * Uses the staging endpoint unless `TRANSAK_ENVIRONMENT=PRODUCTION`.
   *
   * @param params - Widget configuration; `apiKey` is injected automatically.
   * @returns Fully-formed URL to open in a browser or WebView.
   */
  generateWidgetUrl(params: Omit<TransakWidgetParams, 'apiKey'>): string {
    const baseUrl = this.environment === 'PRODUCTION'
      ? 'https://global.transak.com'
      : 'https://global-stg.transak.com';

    const queryParams = new URLSearchParams({
      apiKey: this.apiKey,
      walletAddress: params.walletAddress,
      network: params.network,
    });

    if (params.fiatCurrency) queryParams.set('fiatCurrency', params.fiatCurrency);
    if (params.cryptoCurrency) queryParams.set('cryptoCurrency', params.cryptoCurrency);
    if (params.fiatAmount) queryParams.set('fiatAmount', params.fiatAmount.toString());
    if (params.email) queryParams.set('email', params.email);
    if (params.redirectURL) queryParams.set('redirectURL', params.redirectURL);
    if (params.partnerFee) queryParams.set('partnerFee', params.partnerFee.toString());
    queryParams.set('themeColor', params.themeColor ?? '#7C3AED');

    return `${baseUrl}?${queryParams.toString()}`;
  }

  /**
   * Fetches a buy quote from the Transak API.
   *
   * @param params - Fiat currency, amount, and crypto currency.
   * @returns Quote amounts and fees from Transak.
   * @throws {Error} If the request times out, Transak returns a non-2xx response,
   * or the response is missing expected numeric fields.
   */
  async getBuyQuote(params: {
    fiatCurrency: string;
    fiatAmount: number;
    cryptoCurrency: string;
  }): Promise<{
    cryptoAmount: number;
    feeAmount: number;
  }> {
    const baseUrl = this.environment === 'PRODUCTION'
      ? 'https://api.transak.com'
      : 'https://api-stg.transak.com';

    const url = `${baseUrl}/api/v2/prices`;
    const query = new URLSearchParams({
      apiKey: this.apiKey,
      fiatCurrency: params.fiatCurrency,
      fiatAmount: params.fiatAmount.toString(),
      cryptoCurrency: params.cryptoCurrency,
      network: 'stellar',
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let res: Response;
    try {
      res = await fetch(`${url}?${query.toString()}`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) throw new Error(`transak quote failed: ${res.statusText}`);

    const data = await res.json();
    const quoteData = data?.response?.quote;

    if (!quoteData || typeof quoteData.cryptoAmount !== 'number') {
      throw new Error('transak quote response missing expected crypto amount');
    }

    const feeAmount = quoteData.feeAmount || 0;
    return {
      cryptoAmount: quoteData.cryptoAmount,
      feeAmount: typeof feeAmount === 'number' ? feeAmount : 0,
    };
  }
}

export const transakService = new TransakService();
