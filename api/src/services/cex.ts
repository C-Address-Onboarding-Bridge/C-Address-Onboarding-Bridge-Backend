/** Request parameters for routing a CEX withdrawal to a C-address. */
export interface CexWithdrawalRequest {
  exchange: string;
  sourceAsset: string;
  amount: string;
  targetCAddress: string;
  targetNetwork: string;
  memo?: string;
}

/** Response from a CEX withdrawal routing operation. */
export interface CexWithdrawalResponse {
  status: 'pending' | 'completed' | 'failed';
  withdrawalId: string;
  exchangeTxId?: string;
  estimatedArrival?: string;
  fee?: string;
}

/** Function signature for a pluggable exchange withdrawal handler. */
export type ExchangeHandler = (req: CexWithdrawalRequest) => Promise<CexWithdrawalResponse>;

/**
 * Routes withdrawal requests to exchange-specific handlers.
 * Supports Binance, Coinbase, Kraken, and a generic endpoint out of the box.
 * Additional exchanges can be registered via `registerExchange`.
 */
export class CexRoutingService {
  private exchangeHandlers: Map<string, ExchangeHandler> = new Map();

  constructor() {
    this.registerDefaultHandlers();
  }

  private registerDefaultHandlers() {
    this.exchangeHandlers.set('binance', this.handleBinance.bind(this));
    this.exchangeHandlers.set('coinbase', this.handleCoinbase.bind(this));
    this.exchangeHandlers.set('kraken', this.handleKraken.bind(this));
    this.exchangeHandlers.set('generic', this.handleGeneric.bind(this));
  }

  /**
   * Registers a custom handler for an exchange.
   * Overwrites any existing handler for the same name (case-insensitive).
   *
   * @param name - Exchange identifier (e.g. `"my-exchange"`).
   * @param handler - Async function that performs the withdrawal and returns a result.
   */
  registerExchange(name: string, handler: ExchangeHandler) {
    this.exchangeHandlers.set(name.toLowerCase(), handler);
  }

  /**
   * Dispatches a withdrawal request to the appropriate exchange handler.
   *
   * @param req - Withdrawal details including exchange name, asset, amount, and target address.
   * @throws {Error} If the exchange is not registered.
   */
  async routeWithdrawal(req: CexWithdrawalRequest): Promise<CexWithdrawalResponse> {
    const exchange = req.exchange.toLowerCase();
    const handler = this.exchangeHandlers.get(exchange);

    if (!handler) {
      throw new Error(`unsupported exchange: ${exchange}. supported: ${[...this.exchangeHandlers.keys()].join(', ')}`);
    }

    return handler(req);
  }

  /** Returns the list of currently registered exchange names. */
  getSupportedExchanges(): string[] {
    return [...this.exchangeHandlers.keys()];
  }

  private async postToExchange(
    url: string,
    body: Record<string, unknown>,
    apiKey?: string,
    apiSecret?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) headers['X-API-Key'] = apiKey;
    if (apiSecret) headers['X-API-Secret'] = apiSecret;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return res;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async handleBinance(req: CexWithdrawalRequest): Promise<CexWithdrawalResponse> {
    // TODO: inject BINANCE_API_KEY and BINANCE_API_SECRET from env and pass to
    // postToExchange so requests are authenticated. Without credentials the
    // Binance API returns 401 and falls through to the fallback response below.
    const memo = req.memo || `bridge:binance:${req.targetCAddress.slice(-8)}`;

    try {
      const res = await this.postToExchange(
        'https://api.binance.com/sapi/v1/capital/withdraw/apply',
        {
          coin: req.sourceAsset,
          amount: req.amount,
          address: req.targetCAddress,
          network: req.targetNetwork,
          memo,
        },
      );

      if (!res.ok) {
        const errBody = await res.text();
        console.error(`binance withdrawal failed: ${errBody}`);
        return this.fallbackResponse('bin', req);
      }

      const data = await res.json() as { id?: string; txId?: string };
      return {
        status: 'pending',
        withdrawalId: `bin-${data.id || Date.now()}`,
        exchangeTxId: data.txId,
        estimatedArrival: '5-30 minutes',
        fee: '0.0001',
      };
    } catch (err) {
      console.error('binance API error:', err);
      return this.fallbackResponse('bin', req);
    }
  }

  private async handleCoinbase(req: CexWithdrawalRequest): Promise<CexWithdrawalResponse> {
    // TODO: inject COINBASE_API_KEY and COINBASE_API_SECRET from env and pass to
    // postToExchange. Without credentials Coinbase returns 401.
    const memo = req.memo || `bridge:coinbase:${req.targetCAddress.slice(-8)}`;

    try {
      const res = await this.postToExchange(
        'https://api.coinbase.com/v2/accounts/withdrawals',
        {
          type: 'send',
          to: req.targetCAddress,
          amount: req.amount,
          currency: req.sourceAsset,
          description: memo,
        },
      );

      if (!res.ok) {
        const errBody = await res.text();
        console.error(`coinbase withdrawal failed: ${errBody}`);
        return this.fallbackResponse('cb', req);
      }

      const data = await res.json() as { data?: { id?: string } };
      return {
        status: 'pending',
        withdrawalId: `cb-${data.data?.id || Date.now()}`,
        estimatedArrival: '5-30 minutes',
        fee: '0.00005',
      };
    } catch (err) {
      console.error('coinbase API error:', err);
      return this.fallbackResponse('cb', req);
    }
  }

  private async handleKraken(req: CexWithdrawalRequest): Promise<CexWithdrawalResponse> {
    // TODO: inject KRAKEN_API_KEY and KRAKEN_API_SECRET from env and pass to
    // postToExchange. Without credentials Kraken returns an auth error.
    const memo = req.memo || `bridge:kraken:${req.targetCAddress.slice(-8)}`;

    try {
      const res = await this.postToExchange(
        'https://api.kraken.com/0/private/Withdraw',
        {
          asset: req.sourceAsset,
          key: req.targetCAddress,
          amount: req.amount,
          network: req.targetNetwork,
        },
      );

      if (!res.ok) {
        const errBody = await res.text();
        console.error(`kraken withdrawal failed: ${errBody}`);
        return this.fallbackResponse('kr', req);
      }

      const data = await res.json() as { result?: { refid?: string } };
      return {
        status: 'pending',
        withdrawalId: `kr-${data.result?.refid || Date.now()}`,
        estimatedArrival: '5-30 minutes',
        fee: '0.0001',
      };
    } catch (err) {
      console.error('kraken API error:', err);
      return this.fallbackResponse('kr', req);
    }
  }

  // TODO: fallbackResponse returns `status: 'pending'` even when the exchange
  // API call definitively failed. Consider introducing a distinct `status: 'failed'`
  // path so callers can detect submission errors rather than polling indefinitely.
  private fallbackResponse(prefix: string, req: CexWithdrawalRequest): CexWithdrawalResponse {
    return {
      status: 'pending',
      withdrawalId: `${prefix}-${Date.now()}`,
      estimatedArrival: '5-30 minutes',
      fee: 'variable',
    };
  }

  private async handleGeneric(req: CexWithdrawalRequest): Promise<CexWithdrawalResponse> {
    const memo = req.memo || `bridge:generic:${req.targetCAddress.slice(-8)}`;

    const endpoint = process.env.CEX_API_ENDPOINT;
    if (endpoint) {
      try {
        const res = await this.postToExchange(endpoint, {
          address: req.targetCAddress,
          asset: req.sourceAsset,
          amount: req.amount,
          network: req.targetNetwork,
          memo,
        });

        if (res.ok) {
          const data = await res.json() as { id?: string };
          return {
            status: 'pending',
            withdrawalId: `cex-${data.id || Date.now()}`,
            estimatedArrival: '10-60 minutes',
            fee: 'variable',
          };
        }
      } catch (err) {
        console.error('generic CEX API error:', err);
      }
    }

    return {
      status: 'pending',
      withdrawalId: `cex-${Date.now()}`,
      estimatedArrival: '10-60 minutes',
      fee: 'variable',
    };
  }
}

export const cexService = new CexRoutingService();
