/** Transak API credentials and environment selection. */
export interface TransakConfig {
  apiKey: string;
  environment: 'STAGING' | 'PRODUCTION';
}

/** Parameters for building a Transak widget URL. */
export interface TransakWidgetParams {
  walletAddress: string;
  network?: string;
  fiatCurrency?: string;
  cryptoCurrency?: string;
  fiatAmount?: number;
  email?: string;
  redirectUrl?: string;
  /** Optional partner fee percentage to display in the widget. */
  partnerFee?: number;
}

const BASE_URLS: Record<string, string> = {
  STAGING: 'https://global-stg.transak.com',
  PRODUCTION: 'https://global.transak.com',
};

/**
 * Builds a Transak widget URL for purchasing crypto directly to a Stellar address.
 * Uses the staging endpoint unless `config.environment` is `"PRODUCTION"`.
 *
 * @param config - Transak API credentials and environment.
 * @param params - Widget configuration.
 * @returns Fully-formed URL to open in a browser or WebView.
 */
export function createTransakWidgetUrl(config: TransakConfig, params: TransakWidgetParams): string {
  const baseUrl = BASE_URLS[config.environment] ?? BASE_URLS['STAGING'];
  const query = new URLSearchParams({ apiKey: config.apiKey });

  if (params.walletAddress) query.set('walletAddress', params.walletAddress);
  if (params.network) query.set('network', params.network);
  if (params.fiatCurrency) query.set('fiatCurrency', params.fiatCurrency);
  if (params.cryptoCurrency) query.set('cryptoCurrencyCode', params.cryptoCurrency);
  if (params.fiatAmount != null) query.set('fiatAmount', String(params.fiatAmount));
  if (params.email) query.set('email', params.email);
  if (params.redirectUrl) query.set('redirectURL', params.redirectUrl);
  if (params.partnerFee != null) query.set('partnerFeePercent', String(params.partnerFee));

  return `${baseUrl}?${query.toString()}`;
}
