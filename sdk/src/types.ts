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
  status: 'pending' | 'success' | 'failed';
  hash: string;
  error?: string;
}

export interface TransactionStatus {
  status: 'pending' | 'success' | 'failed';
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
  /** Default request timeout in ms. Defaults to 10 000 ms. */
  defaultTimeout?: number;
  /** Timeout applied to fund-submission requests. Defaults to 30 000 ms. */
  fundSubmissionTimeout?: number;
}

export interface RequestOptions {
  /** Per-request timeout override in ms. */
  timeout?: number;
  /** AbortSignal for explicit cancellation (combined with internal timeout). */
  signal?: AbortSignal;
}

export interface TimeoutMetrics {
  totalRequests: number;
  timedOutRequests: number;
  averageResponseMs: number;
  lastTimeoutAt?: string;
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

export interface PaginationMeta {
  total?: number;
  page?: number;
  totalPages?: number;
}

export interface EnrichedPaginatedResponse<T> extends PaginatedResponse<T> {
  meta: PaginationMeta;
}

export interface AutoPaginateOptions {
  pageSize?: number;
  concurrency?: number;
  throttleMs?: number;
  signal?: AbortSignal;
}

export type PageFetcher<T> = (params: PaginatedRequestParams) => Promise<PaginatedResponse<T>>;

// ── Events (Issue #57) ────────────────────────────────────────────────────────

export type BridgeEventType =
  | 'transaction:pending'
  | 'transaction:success'
  | 'transaction:failed'
  | 'transaction:status:changed'
  | 'online'
  | 'offline'
  | 'reconnecting'
  | 'error'
  | 'queue:drained';

export interface BridgeEventDataMap {
  'transaction:pending': { txHash: string; status: TransactionStatus };
  'transaction:success': { txHash: string; status: TransactionStatus };
  'transaction:failed': { txHash: string; status: TransactionStatus; error?: string };
  'transaction:status:changed': { txHash: string; status: TransactionStatus; previousStatus: string };
  'online': { at: string };
  'offline': { at: string };
  'reconnecting': { attempt: number; at: string };
  'error': { message: string; error?: unknown };
  'queue:drained': { processedCount: number; at: string };
}

export interface BridgeEvent<K extends BridgeEventType = BridgeEventType> {
  type: K;
  data: K extends keyof BridgeEventDataMap ? BridgeEventDataMap[K] : never;
  timestamp: string;
}

export type EventHandler<K extends BridgeEventType = BridgeEventType> = (
  event: BridgeEvent<K>
) => void;

export interface EventEmitterOptions {
  /** Interval between transaction status polls. Defaults to 2 000 ms. */
  pollIntervalMs?: number;
  /** Number of past events to retain for late subscribers. Defaults to 100. */
  historySize?: number;
  /** Interval between server health checks. Defaults to 10 000 ms. */
  healthCheckIntervalMs?: number;
}
