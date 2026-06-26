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
  RequestParams,
  FundingPrepareResult,
} from './types';
import { SimpleCache } from './cache';
import { TelemetryClient } from './telemetry';

export interface BridgeClientConfig {
  baseUrl: string;
  apiKey?: string;
  telemetry?: boolean;
  cache?: {
    quoteTtlMs?: number;
    statusTtlMs?: number;
    healthTtlMs?: number;
    staleWhileRevalidate?: boolean;
    maxEntries?: number;
    debug?: boolean;
  };
}

const REQUEST_TIMEOUT_MS = 30_000;
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class BridgeClient {
  private baseUrl: string;
  private apiKey?: string;
  private readonly cache: SimpleCache;
  private readonly telemetry: TelemetryClient;
  private readonly config: BridgeClientConfig;

  constructor(config: BridgeClientConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.cache = new SimpleCache({
      maxEntries: config.cache?.maxEntries,
      debug: config.cache?.debug,
    });
    const runtimeProcess = typeof process !== 'undefined' ? process : undefined;
    this.telemetry = new TelemetryClient({
      enabled: config.telemetry ?? (runtimeProcess?.env?.SDK_TELEMETRY_ENABLED !== 'false'),
      intervalMs: 60_000,
      endpoint: `${this.baseUrl}/api/telemetry`,
    });
  }

  private async request<T>(
    method: HttpMethod,
    path: string,
    body?: Record<string, unknown>,
    params?: RequestParams,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, val] of Object.entries(params)) {
        if (val !== undefined) {
          url.searchParams.set(key, String(val));
        }
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({} as Record<string, unknown>));
        const errorMessage = typeof errBody === 'object' && errBody !== null && 'message' in errBody && typeof errBody.message === 'string'
          ? errBody.message
          : `request failed: ${res.statusText}`;
        throw new Error(errorMessage);
      }

      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timeout);
    }
  }

  async requestPaginated<T>(path: string, params?: PaginatedRequestParams): Promise<PaginatedResponse<T>> {
    const queryParams: RequestParams = {};
    if (params?.cursor !== undefined) queryParams['cursor'] = params.cursor;
    if (params?.limit !== undefined) queryParams['limit'] = String(params.limit);
    if (params?.offset !== undefined) queryParams['offset'] = String(params.offset);
    return this.request<PaginatedResponse<T>>('GET', path, undefined, queryParams);
  }

  async getQuote(params: QuoteParams): Promise<Quote> {
    const cacheKey = `quote:${params.sourceAsset}:${params.amount}:${params.targetAddress}`;
    const cached = this.cache.get<Quote>(cacheKey);
    if (cached) {
      return cached.value;
    }

    const startedAt = Date.now();
    try {
      const result = await this.request<Quote>('GET', '/api/v1/quote', undefined, {
        sourceAsset: params.sourceAsset,
        amount: params.amount,
        targetAddress: params.targetAddress,
      });
      this.cache.set(cacheKey, result, this.getTtl('quote'), this.shouldUseStaleWhileRevalidate());
      this.telemetry.record({ method: 'getQuote', responseTimeMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      this.telemetry.record({ method: 'getQuote', responseTimeMs: Date.now() - startedAt, errorType: error instanceof Error ? error.name : 'UnknownError' });
      throw error;
    }
  }

  async submitSignedXdr(params: FundWithXdrParams): Promise<FundingResult> {
    return this.request<FundingResult>('POST', '/api/v1/fund', {
      signedXdr: params.signedXdr,
    });
  }

  async prepareFundingTransaction(params: FundParams): Promise<FundingPrepareResult> {
    return this.request<FundingPrepareResult>('POST', '/api/v1/fund/prepare', {
      sourceAddress: params.sourceAddress,
      targetAddress: params.targetAddress,
      tokenAddress: params.tokenAddress,
      amount: params.amount,
      memo: params.memo || '',
    });
  }

  async getStatus(txHash: string): Promise<TransactionStatus> {
    const cacheKey = `status:${txHash}`;
    const cached = this.cache.get<TransactionStatus>(cacheKey);
    if (cached) {
      return cached.value;
    }

    const startedAt = Date.now();
    try {
      const result = await this.request<TransactionStatus>('GET', `/api/v1/status/${txHash}`);
      this.cache.set(cacheKey, result, this.getTtl('status'), this.shouldUseStaleWhileRevalidate());
      this.telemetry.record({ method: 'getStatus', responseTimeMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      this.telemetry.record({ method: 'getStatus', responseTimeMs: Date.now() - startedAt, errorType: error instanceof Error ? error.name : 'UnknownError' });
      throw error;
    }
  }

  async createMoonpayUrl(params: MoonpayWidgetParams): Promise<MoonpayWidgetResult> {
    return this.request<MoonpayWidgetResult>('POST', '/api/v1/offramp/moonpay', params as unknown as Record<string, unknown>);
  }

  async createTransakUrl(params: TransakWidgetParams): Promise<TransakWidgetResult> {
    return this.request<TransakWidgetResult>('POST', '/api/v1/offramp/transak', params as unknown as Record<string, unknown>);
  }

  async health(): Promise<{ status: string }> {
    const cacheKey = 'health';
    const cached = this.cache.get<{ status: string }>(cacheKey);
    if (cached) {
      return cached.value;
    }

    const startedAt = Date.now();
    try {
      const result = await this.request<{ status: string }>('GET', '/health');
      this.cache.set(cacheKey, result, this.getTtl('health'), this.shouldUseStaleWhileRevalidate());
      this.telemetry.record({ method: 'health', responseTimeMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      this.telemetry.record({ method: 'health', responseTimeMs: Date.now() - startedAt, errorType: error instanceof Error ? error.name : 'UnknownError' });
      throw error;
    }
  }

  async routeCexWithdrawal(params: CexWithdrawalParams): Promise<CexWithdrawalResult> {
    return this.request<CexWithdrawalResult>('POST', '/api/v1/cex/route', params as unknown as Record<string, unknown>);
  }

  invalidateQuoteCache(params: QuoteParams): void {
    const cacheKey = `quote:${params.sourceAsset}:${params.amount}:${params.targetAddress}`;
    this.cache.invalidate(cacheKey);
  }

  private getTtl(kind: 'quote' | 'status' | 'health'): number {
    const defaults = { quote: 15_000, status: 5_000, health: 30_000 } as const;
    return this.getCacheOption(kind, defaults[kind]);
  }

  private getCacheOption(kind: 'quote' | 'status' | 'health', fallback: number): number {
    if (!this.config.cache) return fallback;

    switch (kind) {
      case 'quote':
        return this.config.cache.quoteTtlMs ?? fallback;
      case 'status':
        return this.config.cache.statusTtlMs ?? fallback;
      case 'health':
        return this.config.cache.healthTtlMs ?? fallback;
      default:
        return fallback;
    }
  }

  private shouldUseStaleWhileRevalidate(): boolean {
    return this.config.cache?.staleWhileRevalidate ?? true;
  }
}
