/** Parameters for requesting a funding quote. */
export interface QuoteParams {
  /** Asset code to send (e.g. `XLM`, `USDC`). */
  sourceAsset: string;
  /** Amount in stroops as an integer string. */
  amount: string;
  /** Destination C-address or G-address. */
  targetAddress: string;
}

/** Fee quote returned by the bridge API. */
export interface Quote {
  /** Protocol fee in stroops. */
  estimatedFee: string;
  /** Amount the recipient will receive after fees, in stroops. */
  expectedReceive: string;
  /** Fee rate in basis points (1 bps = 0.01%). */
  feeBps: number;
  /** Exchange rate applied (currently always `"1.0"`). */
  rate: string;
}

/** Parameters for preparing an unsigned funding transaction. */
export interface FundParams {
  sourceAddress: string;
  targetAddress: string;
  tokenAddress: string;
  /** Amount in stroops as an integer string. */
  amount: string;
  memo?: string;
}

/** Parameters for submitting a pre-signed transaction XDR. */
export interface FundWithXdrParams {
  /** Base64-encoded signed transaction envelope. */
  signedXdr: string;
}

/** Result of a funding transaction submission. */
export interface FundingResult {
  status: 'pending' | 'success' | 'failed';
  hash: string;
  error?: string;
}

/** Live status of a previously submitted transaction. */
export interface TransactionStatus {
  status: 'pending' | 'success' | 'failed';
  hash: string;
  error?: string;
}

/** Parameters for generating a MoonPay widget URL. */
export interface MoonpayWidgetParams {
  currencyCode?: string;
  walletAddress: string;
  walletNetwork?: string;
  baseCurrencyAmount?: number;
  baseCurrencyCode?: string;
  email?: string;
}

/** Response containing a MoonPay widget URL. */
export interface MoonpayWidgetResult {
  url: string;
}

/** Parameters for generating a Transak widget URL. */
export interface TransakWidgetParams {
  walletAddress: string;
  network?: string;
  fiatCurrency?: string;
  cryptoCurrency?: string;
  fiatAmount?: number;
  email?: string;
  redirectURL?: string;
}

/** Response containing a Transak widget URL. */
export interface TransakWidgetResult {
  url: string;
}

/** Parameters for routing a CEX withdrawal to a C-address. */
export interface CexWithdrawalParams {
  exchange: 'binance' | 'coinbase' | 'kraken' | 'generic';
  sourceAsset: string;
  /** Amount in stroops as an integer string. */
  amount: string;
  targetCAddress: string;
  targetNetwork?: string;
  memo?: string;
}

/** Result from a CEX withdrawal routing request. */
export interface CexWithdrawalResult {
  status: 'pending' | 'completed' | 'failed';
  withdrawalId: string;
  exchangeTxId?: string;
  estimatedArrival?: string;
  fee?: string;
}

/** Configuration for {@link BridgeClient}. */
export interface BridgeClientConfig {
  /** Base URL of the bridge API server (trailing slash is stripped automatically). */
  baseUrl: string;
  /** Optional API key sent as `X-API-Key` on every request. */
  apiKey?: string;
}
