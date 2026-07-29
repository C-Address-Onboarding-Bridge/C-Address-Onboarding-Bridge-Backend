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
}

export const transakService = new TransakService();
