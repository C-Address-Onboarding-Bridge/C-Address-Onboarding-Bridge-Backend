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
  BridgeClientConfig,
} from './types';

export type { BridgeClientConfig };

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * TypeScript client for the C-Address Onboarding Bridge API.
 *
 * @example
 * const client = new BridgeClient({ baseUrl: 'https://api.bridge.example.com', apiKey: 'key' });
 * const quote = await client.getQuote({ sourceAsset: 'XLM', amount: '10000000', targetAddress: 'C...' });
 */
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

  /**
   * Fetches a fee quote for a prospective funding transaction.
   *
   * @param params - Source asset, amount in stroops, and destination address.
   * @returns Estimated fee, expected receive amount, fee rate, and exchange rate.
   */
  async getQuote(params: QuoteParams): Promise<Quote> {
    return this.request<Quote>('GET', '/api/v1/quote', undefined, {
      sourceAsset: params.sourceAsset,
      amount: params.amount,
      targetAddress: params.targetAddress,
    });
  }

  /**
   * Submits a pre-signed Soroban transaction XDR to the bridge contract.
   *
   * @param params - Object containing the base64-encoded signed transaction envelope.
   * @returns Transaction status and hash.
   */
  async submitSignedXdr(params: FundWithXdrParams): Promise<FundingResult> {
    return this.request<FundingResult>('POST', '/api/v1/fund', {
      signedXdr: params.signedXdr,
    });
  }

  /**
   * Prepares an unsigned funding transaction for client-side signing.
   * Returns a simulation result and instructions for the caller to sign and submit.
   *
   * @param params - Source/target addresses, token address, amount, and memo.
   */
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

  /**
   * Polls the bridge API for the current status of a submitted transaction.
   *
   * @param txHash - Hex-encoded transaction hash returned by `submitSignedXdr`.
   */
  async getStatus(txHash: string): Promise<TransactionStatus> {
    return this.request<TransactionStatus>('GET', `/api/v1/status/${txHash}`);
  }

  /**
   * Requests a MoonPay widget URL for fiat → C-address funding.
   *
   * @param params - MoonPay widget configuration (wallet address, currency, etc.).
   * @returns URL to open in a browser or WebView.
   */
  async createMoonpayUrl(params: MoonpayWidgetParams): Promise<MoonpayWidgetResult> {
    return this.request<MoonpayWidgetResult>('POST', '/api/v1/offramp/moonpay', params as unknown as Record<string, unknown>);
  }

  /**
   * Requests a Transak widget URL for fiat → C-address funding.
   *
   * @param params - Transak widget configuration (wallet address, network, etc.).
   * @returns URL to open in a browser or WebView.
   */
  async createTransakUrl(params: TransakWidgetParams): Promise<TransakWidgetResult> {
    return this.request<TransakWidgetResult>('POST', '/api/v1/offramp/transak', params as unknown as Record<string, unknown>);
  }

  /**
   * Routes a CEX withdrawal directly to a C-address via the bridge API.
   *
   * @param params - Exchange name, asset, amount, and target C-address.
   * @returns Withdrawal ID and estimated arrival time.
   */
  async routeCexWithdrawal(params: CexWithdrawalParams): Promise<CexWithdrawalResult> {
    return this.request<CexWithdrawalResult>('POST', '/api/v1/cex/route', params as unknown as Record<string, unknown>);
  }
}
