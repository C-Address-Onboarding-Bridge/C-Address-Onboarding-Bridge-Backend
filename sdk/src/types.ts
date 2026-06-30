export type BridgeStatus = 'pending' | 'success' | 'failed';
export type RequestValue = string | number | boolean | undefined;
export type RequestParams = Record<string, RequestValue>;
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// ─── Token Types ──────────────────────────────────────────────────────────────

/** Discriminated union representing a token type for bridge operations. */
export type Token =
  | { type: 'native' }
  | { type: 'sac'; contractId: string };

/** Metadata for a Stellar Asset Converter (SAC) token. */
export interface TokenMetadata {
  /** Number of decimal places the token uses (e.g. 6 for USDC, 7 for XLM). */
  decimals: number;
  /** Human-readable token name. */
  name: string;
  /** Token symbol (e.g. `USDC`, `yUSDC`). */
  symbol: string;
  /** Issuer account address (G-address), if applicable. */
  issuer?: string;
}

/** Parameters for requesting token metadata. */
export interface TokenMetadataParams {
  contractId: string;
}

export interface RequestOptions {
  timeout?: number;
}

/** Parameters for requesting a funding quote. */
export interface QuoteParams {
  /** Asset code to send (e.g. `XLM`, `USDC`). */
  sourceAsset: string;
  /** Amount in stroops as an integer string. */
  amount: string;
  /** Destination C-address or G-address. */
  targetAddress: string;
  /** Optional token specification. When provided, the SDK will use the token contract for the operation. Defaults to native XLM when omitted. */
  token?: Token;
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
  /** Token contract address (C-address). Kept for backward compatibility; prefer `token` for type safety. */
  tokenAddress: string;
  /** Amount in stroops as an integer string. */
  amount: string;
  memo?: string;
  /** Optional typed token specification. When provided alongside `tokenAddress`, `token` takes precedence for fee/metadata logic. Defaults to native XLM when omitted. */
  token?: Token;
}

/** Parameters for submitting a pre-signed transaction XDR. */
export interface FundWithXdrParams {
  /** Base64-encoded signed transaction envelope. */
  signedXdr: string;
}

/** Result of a funding transaction submission. */
export interface FundingResult {
  status: BridgeStatus;
  hash: string;
  error?: string;
}

/** Live status of a previously submitted transaction. */
export interface TransactionStatus {
  status: BridgeStatus;
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

export interface RequestSigningConfig {
  /** Enable HMAC-SHA256 request signing. Unsigned requests still work when false. */
  enabled: boolean;
  /** Clock skew tolerance in milliseconds (default: 30 000). */
  clockSkewToleranceMs?: number;
}

/** Configuration for {@link BridgeClient}. */
export interface BridgeClientConfig {
  /** Base URL of the bridge API server (trailing slash is stripped automatically). */
  baseUrl: string;
  /** Optional API key sent as `X-API-Key` on every request. */
  apiKey?: string;
  signing?: RequestSigningConfig;
  retry?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    retryBudgetMs?: number;
    jitterMs?: number;
    logger?: Pick<Console, 'debug'>;
  };
  cache?: {
    quoteTtlMs?: number;
    statusTtlMs?: number;
    healthTtlMs?: number;
    staleWhileRevalidate?: boolean;
    maxEntries?: number;
  };
  telemetry?: {
    endpoint?: string;
    enabled?: boolean;
    intervalMs?: number;
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

// Pagination helpers

export interface AutoPaginateOptions {
  pageSize?: number;
  throttleMs?: number;
  concurrency?: number;
  signal?: AbortSignal;
}

export type PageFetcher<T> = (params: PaginatedRequestParams) => Promise<PaginatedResponse<T>>;

// Offline queue

export interface StorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface QueueEntry {
  id: string;
  timestamp: string;
  retryCount: number;
  method: HttpMethod;
  path: string;
  body?: Record<string, unknown>;
  params?: Record<string, string | undefined>;
}

export interface OfflineQueueOptions {
  maxSize?: number;
  storageAdapter?: StorageAdapter;
  healthCheckIntervalMs?: number;
  autoQueue?: boolean;
  healthCheckPath?: string;
}

// Event emitter

export type BridgeEventType =
  | 'transaction:pending'
  | 'transaction:success'
  | 'transaction:failed'
  | 'transaction:status:changed'
  | 'error'
  | 'online'
  | 'offline'
  | 'reconnecting';

export interface BridgeEventDataMap {
  'transaction:pending': { txHash: string; status: TransactionStatus };
  'transaction:success': { txHash: string; status: TransactionStatus };
  'transaction:failed': { txHash: string; status: TransactionStatus; error?: string };
  'transaction:status:changed': { txHash: string; status: TransactionStatus; previousStatus: string };
  'error': { message: string; error: unknown };
  'online': { at: string };
  'offline': { at: string };
  'reconnecting': { attempt: number; at: string };
}

export interface BridgeEvent<K extends BridgeEventType = BridgeEventType> {
  type: K;
  data: K extends keyof BridgeEventDataMap ? BridgeEventDataMap[K] : never;
  timestamp: string;
}

export type EventHandler<K extends BridgeEventType = BridgeEventType> = (event: BridgeEvent<K>) => void;

export interface EventEmitterOptions {
  pollIntervalMs?: number;
  historySize?: number;
  healthCheckIntervalMs?: number;
}
