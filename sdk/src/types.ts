export type BridgeStatus = 'pending' | 'success' | 'failed';
export type RequestValue = string | number | boolean | undefined;
export type RequestParams = Record<string, RequestValue>;

export interface QuoteParams {
  sourceAsset: string;
  amount: string;
  targetAddress: string;
}

export interface Quote {
  estimatedFee: string;
  expectedReceive: string;
  feeBps: number;
  rate: string;
}

export interface FundParams {
  sourceAddress: string;
  targetAddress: string;
  tokenAddress: string;
  amount: string;
  memo?: string;
}

export interface FundWithXdrParams {
  signedXdr: string;
}

export interface FundingResult {
  status: BridgeStatus;
  hash: string;
  error?: string;
}

export interface TransactionStatus {
  status: BridgeStatus;
  hash: string;
  error?: string;
}

export interface MoonpayWidgetParams {
  currencyCode?: string;
  walletAddress: string;
  walletNetwork?: string;
  baseCurrencyAmount?: number;
  baseCurrencyCode?: string;
  email?: string;
}

export interface MoonpayWidgetResult {
  url: string;
}

export interface TransakWidgetParams {
  walletAddress: string;
  network?: string;
  fiatCurrency?: string;
  cryptoCurrency?: string;
  fiatAmount?: number;
  email?: string;
  redirectURL?: string;
}

export interface TransakWidgetResult {
  url: string;
}

export interface CexWithdrawalParams {
  exchange: 'binance' | 'coinbase' | 'kraken' | 'generic';
  sourceAsset: string;
  amount: string;
  targetCAddress: string;
  targetNetwork?: string;
  memo?: string;
}

export interface CexWithdrawalResult {
  status: 'pending' | 'completed' | 'failed';
  withdrawalId: string;
  exchangeTxId?: string;
  estimatedArrival?: string;
  fee?: string;
}

export interface BridgeClientConfig {
  baseUrl: string;
  apiKey?: string;
  retry?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    retryBudgetMs?: number;
    jitterMs?: number;
    logger?: Pick<Console, 'debug'>;
  };
}

export interface PaginatedRequestParams {
  cursor?: string;
  limit?: number;
  offset?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface FundingPrepareResult {
  instruction: string;
  simulation: Record<string, string>;
  params: FundParams;
}
