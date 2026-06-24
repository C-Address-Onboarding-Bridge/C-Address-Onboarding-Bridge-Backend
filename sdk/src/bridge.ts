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
} from './types';

export interface BridgeClientConfig {
  baseUrl: string;
  apiKey?: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class BridgeClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(config: BridgeClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      Object.entries(params).forEach(([key, val]) => {
        if (val !== undefined) url.searchParams.set(key, val);
      });
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
        const errBody = await res.json().catch(() => ({} as Record<string, string>));
        throw new Error((errBody as { message?: string }).message || `request failed: ${res.statusText}`);
      }

      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timeout);
    }
  }

  async requestPaginated<T>(path: string, params?: PaginatedRequestParams): Promise<PaginatedResponse<T>> {
    const queryParams: Record<string, string | undefined> = {};
    if (params?.cursor !== undefined) queryParams['cursor'] = params.cursor;
    if (params?.limit !== undefined) queryParams['limit'] = String(params.limit);
    if (params?.offset !== undefined) queryParams['offset'] = String(params.offset);
    return this.request<PaginatedResponse<T>>('GET', path, undefined, queryParams);
  }

  async getQuote(params: QuoteParams): Promise<Quote> {
    return this.request<Quote>('GET', '/api/v1/quote', undefined, {
      sourceAsset: params.sourceAsset,
      amount: params.amount,
      targetAddress: params.targetAddress,
    });
  }

  async submitSignedXdr(params: FundWithXdrParams): Promise<FundingResult> {
    return this.request<FundingResult>('POST', '/api/v1/fund', {
      signedXdr: params.signedXdr,
    });
  }

  async prepareFundingTransaction(params: FundParams): Promise<{
    instruction: string;
    simulation: Record<string, string>;
    params: FundParams;
  }> {
    return this.request('POST', '/api/v1/fund/prepare', {
      sourceAddress: params.sourceAddress,
      targetAddress: params.targetAddress,
      tokenAddress: params.tokenAddress,
      amount: params.amount,
      memo: params.memo || '',
    });
  }

  async getStatus(txHash: string): Promise<TransactionStatus> {
    return this.request<TransactionStatus>('GET', `/api/v1/status/${txHash}`);
  }

  async createMoonpayUrl(params: MoonpayWidgetParams): Promise<MoonpayWidgetResult> {
    return this.request<MoonpayWidgetResult>('POST', '/api/v1/offramp/moonpay', params as unknown as Record<string, unknown>);
  }

  async createTransakUrl(params: TransakWidgetParams): Promise<TransakWidgetResult> {
    return this.request<TransakWidgetResult>('POST', '/api/v1/offramp/transak', params as unknown as Record<string, unknown>);
  }

  async routeCexWithdrawal(params: CexWithdrawalParams): Promise<CexWithdrawalResult> {
    return this.request<CexWithdrawalResult>('POST', '/api/v1/cex/route', params as unknown as Record<string, unknown>);
  }
}
