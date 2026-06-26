import {
  QuoteParams,
  Quote,
  FundParams,
  FundWithXdrParams,
  FundingResult,
  TransactionStatus,
  MoonpayWidgetParams,
  MoonpayWidgetResult,
  TransakWidgetParams,
  TransakWidgetResult,
  CexWithdrawalParams,
  CexWithdrawalResult,
  PaginatedRequestParams,
  PaginatedResponse,
  AutoPaginateOptions,
  RequestOptions,
  TimeoutMetrics,
} from './types';
import { TimeoutError } from './errors';
import { PaginationHelper } from './pagination';

export interface BridgeClientConfig {
  baseUrl: string;
  apiKey?: string;
  /** Default request timeout in ms. Defaults to 10 000 ms. */
  defaultTimeout?: number;
  /** Timeout applied to fund-submission requests. Defaults to 30 000 ms. */
  fundSubmissionTimeout?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const FUND_SUBMISSION_TIMEOUT_MS = 30_000;

export class BridgeClient {
  private baseUrl: string;
  private apiKey?: string;
  private defaultTimeout: number;
  private fundSubmissionTimeout: number;
  private metrics: TimeoutMetrics = {
    totalRequests: 0,
    timedOutRequests: 0,
    averageResponseMs: 0,
  };

  constructor(config: BridgeClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.defaultTimeout = config.defaultTimeout ?? DEFAULT_TIMEOUT_MS;
    this.fundSubmissionTimeout = config.fundSubmissionTimeout ?? FUND_SUBMISSION_TIMEOUT_MS;
  }

  /** Returns a snapshot of timeout and latency metrics for all requests. */
  getTimeoutMetrics(): TimeoutMetrics {
    return { ...this.metrics };
  }

  protected async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string | undefined>,
    options?: RequestOptions,
  ): Promise<T> {
    const timeoutMs = options?.timeout ?? this.defaultTimeout;
    const startTime = Date.now();
    this.metrics.totalRequests++;

    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      Object.entries(params).forEach(([key, val]) => {
        if (val !== undefined) url.searchParams.set(key, val);
      });
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;

    const timeoutController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);

    const onUserAbort = () => timeoutController.abort();
    options?.signal?.addEventListener('abort', onUserAbort);

    try {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: timeoutController.signal,
      });

      const elapsed = Date.now() - startTime;
      const n = this.metrics.totalRequests;
      this.metrics.averageResponseMs = (this.metrics.averageResponseMs * (n - 1) + elapsed) / n;

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({} as Record<string, string>));
        throw new Error((errBody as { message?: string }).message || `request failed: ${res.statusText}`);
      }

      return res.json() as Promise<T>;
    } catch (err) {
      if (timedOut) {
        this.metrics.timedOutRequests++;
        this.metrics.lastTimeoutAt = new Date().toISOString();
        throw new TimeoutError(path, timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onUserAbort);
    }
  }

  paginate<T>(path: string, options?: AutoPaginateOptions): PaginationHelper<T> {
    return new PaginationHelper<T>(
      (params) =>
        this.request<PaginatedResponse<T>>('GET', path, undefined, {
          cursor: params?.cursor,
          limit: params?.limit !== undefined ? String(params.limit) : undefined,
          offset: params?.offset !== undefined ? String(params.offset) : undefined,
        }),
      options,
    );
  }

  async requestPaginated<T>(path: string, params?: PaginatedRequestParams): Promise<PaginatedResponse<T>> {
    const queryParams: Record<string, string | undefined> = {};
    if (params?.cursor !== undefined) queryParams['cursor'] = params.cursor;
    if (params?.limit !== undefined) queryParams['limit'] = String(params.limit);
    if (params?.offset !== undefined) queryParams['offset'] = String(params.offset);
    return this.request<PaginatedResponse<T>>('GET', path, undefined, queryParams);
  }

  async getQuote(params: QuoteParams, options?: RequestOptions): Promise<Quote> {
    return this.request<Quote>(
      'GET',
      '/api/v1/quote',
      undefined,
      { sourceAsset: params.sourceAsset, amount: params.amount, targetAddress: params.targetAddress },
      options,
    );
  }

  async submitSignedXdr(params: FundWithXdrParams, options?: RequestOptions): Promise<FundingResult> {
    return this.request<FundingResult>(
      'POST',
      '/api/v1/fund',
      { signedXdr: params.signedXdr },
      undefined,
      { timeout: this.fundSubmissionTimeout, ...options },
    );
  }

  async prepareFundingTransaction(
    params: FundParams,
    options?: RequestOptions,
  ): Promise<{ instruction: string; simulation: Record<string, string>; params: FundParams }> {
    return this.request(
      'POST',
      '/api/v1/fund/prepare',
      {
        sourceAddress: params.sourceAddress,
        targetAddress: params.targetAddress,
        tokenAddress: params.tokenAddress,
        amount: params.amount,
        memo: params.memo || '',
      },
      undefined,
      options,
    );
  }

  async getStatus(txHash: string, options?: RequestOptions): Promise<TransactionStatus> {
    return this.request<TransactionStatus>('GET', `/api/v1/status/${txHash}`, undefined, undefined, options);
  }

  async createMoonpayUrl(params: MoonpayWidgetParams, options?: RequestOptions): Promise<MoonpayWidgetResult> {
    return this.request<MoonpayWidgetResult>(
      'POST',
      '/api/v1/offramp/moonpay',
      params as unknown as Record<string, unknown>,
      undefined,
      options,
    );
  }

  async createTransakUrl(params: TransakWidgetParams, options?: RequestOptions): Promise<TransakWidgetResult> {
    return this.request<TransakWidgetResult>(
      'POST',
      '/api/v1/offramp/transak',
      params as unknown as Record<string, unknown>,
      undefined,
      options,
    );
  }

  async routeCexWithdrawal(params: CexWithdrawalParams, options?: RequestOptions): Promise<CexWithdrawalResult> {
    return this.request<CexWithdrawalResult>(
      'POST',
      '/api/v1/cex/route',
      params as unknown as Record<string, unknown>,
      undefined,
      options,
    );
  }
}
