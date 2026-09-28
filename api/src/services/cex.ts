import crypto from 'crypto';
import { config } from '../config';

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
 * Scope required to trigger a withdrawal from the operator's exchange accounts.
 * This is intentionally NOT granted to legacy or default API keys.
 */
export const CEX_WITHDRAW_SCOPE = 'cex:withdraw';

/**
 * Error thrown when a caller attempts a withdrawal without the required scope.
 * Routes should map this to a 403 response.
 */
export class CexWithdrawalForbiddenError extends Error {
  constructor(message = 'withdrawals require the cex:withdraw scope') {
    super(message);
    this.name = 'CexWithdrawalForbiddenError';
  }
}

/**
 * Number of decimal places (smallest-unit exponent) for supported assets.
 * Exchange withdrawal APIs expect amounts denominated in whole coin units,
 * while the API contract accepts integer strings in the asset's smallest unit
 * (stroops for Stellar assets).
 */
export const ASSET_DECIMALS: Record<string, number> = {
  XLM: 7,
  USDC: 7,
  BTC: 8,
  ETH: 18,
};

/**
 * Converts an integer string expressed in an asset's smallest unit (e.g.
 * stroops) into the decimal whole-unit string expected by exchange APIs.
 *
 * @param amount - Integer string in the asset's smallest unit.
 * @param asset - Asset symbol (case-insensitive).
 * @returns Decimal string in whole units, or the original amount if the asset
 *          is unknown or the input is not a valid integer string.
 */
export function toWholeUnits(amount: string, asset: string): string {
  const decimals = ASSET_DECIMALS[asset.toUpperCase()];
  if (decimals === undefined || !/^-?\d+$/.test(amount)) {
    return amount;
  }

  const negative = amount.startsWith('-');
  const digits = (negative ? amount.slice(1) : amount).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  const result = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${result}` : result;
}

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
   * Withdrawals move funds out of the operator's exchange accounts, so they
   * must only be reachable by callers holding the explicit `cex:withdraw`
   * scope. Legacy/default keys (which only receive `cex:read`) are rejected
   * before any exchange handler runs.
   *
   * @param req - Withdrawal details including exchange name, asset, amount, and target address.
   * @param scopes - Scopes granted to the calling API key.
   * @throws {CexWithdrawalForbiddenError} If the caller lacks the `cex:withdraw` scope.
   * @throws {Error} If the exchange is not registered.
   */
  async routeWithdrawal(
    req: CexWithdrawalRequest,
    scopes: string[] = [],
  ): Promise<CexWithdrawalResponse> {
    if (!scopes.includes(CEX_WITHDRAW_SCOPE)) {
      throw new CexWithdrawalForbiddenError();
    }

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
    headers: Record<string, string>,
    body: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      return res;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Binance: query-string params signed with HMAC-SHA256, key sent via `X-MBX-APIKEY`. */
  private signBinance(
    params: Record<string, string>,
    apiSecret: string,
  ): { query: string; headers: Record<string, string> } {
    const query = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: '5000' }).toString();
    const signature = crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
    return {
      query: `${query}&signature=${signature}`,
      headers: { 'X-MBX-APIKEY': config.cex.binance.apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    };
  }

  /** Coinbase: `CB-ACCESS-*` headers, HMAC-SHA256 of timestamp+method+path+body, base64. */
  private signCoinbase(
    requestPath: string,
    body: string,
  ): Record<string, string> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const prehash = `${timestamp}POST${requestPath}${body}`;
    const signature = crypto
      .createHmac('sha256', Buffer.from(config.cex.coinbase.apiSecret, 'base64'))
      .update(prehash)
      .digest('base64');
    return {
      'Content-Type': 'application/json',
      'CB-ACCESS-KEY': config.cex.coinbase.apiKey,
      'CB-ACCESS-SIGN': signature,
      'CB-ACCESS-TIMESTAMP': timestamp,
      'CB-ACCESS-PASSPHRASE': config.cex.coinbase.passphrase,
    };
  }

  /** Kraken: form-encoded body with nonce, `API-Sign` = HMAC-SHA512(path + SHA256(nonce + postData)). */
  private signKraken(
    path: string,
    params: Record<string, string>,
  ): { body: string; headers: Record<string, string> } {
    const nonce = String(Date.now());
    const body = new URLSearchParams({ ...params, nonce }).toString();
    const sha256Hash = crypto.createHash('sha256').update(nonce + body).digest();
    const message = Buffer.concat([Buffer.from(path), sha256Hash]);
    const signature = crypto
      .createHmac('sha512', Buffer.from(config.cex.kraken.apiSecret, 'base64'))
      .update(message)
      .digest('base64');
    return {
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'API-Key': config.cex.kraken.apiKey,
        'API-Sign': signature,
      },
    };
  }

  private async handleBinance(req: CexWithdrawalRequest): Promise<CexWithdrawalResponse> {
    const memo = req.memo || `bridge:binance:${req.targetCAddress.slice(-8)}`;

    try {
      const { query, headers } = this.signBinance(
        {
          coin: req.sourceAsset.toUpperCase(),
          address: req.targetCAddress,
          amount: toWholeUnits(req.amount, req.sourceAsset),
          network: req.targetNetwork,
          addressTag: memo,
        },
        config.cex.binance.apiSecret,
      );

      const res = await this.postToExchange(
        `${config.cex.binance.baseUrl}/sapi/v1/capital/withdraw/apply?${query}`,
        headers,
        '',
      );

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`binance withdrawal failed (${res.status}): ${text}`);
      }

      const data = (await res.json()) as { id?: string };
      return {
        status: 'pending',
        withdrawalId: data.id || `binance-${Date.now()}`,
        exchangeTxId: data.id,
      };
    } catch (err) {
      return {
        status: 'failed',
        withdrawalId: `binance-${Date.now()}`,
      };
    }
  }

  private async handleCoinbase(req: CexWithdrawalRequest): Promise<CexWithdrawalResponse> {
    const requestPath = '/v2/accounts/withdrawals';
    const body = JSON.stringify({
      type: 'crypto',
      to: req.targetCAddress,
      amount: toWholeUnits(req.amount, req.sourceAsset),
      currency: req.sourceAsset.toUpperCase(),
      network: req.targetNetwork,
      destination_tag: req.memo,
    });

    try {
      const headers = this.signCoinbase(requestPath, body);
      const res = await this.postToExchange(
        `${config.cex.coinbase.baseUrl}${requestPath}`,
        headers,
        body,
      );

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`coinbase withdrawal failed (${res.status}): ${text}`);
      }

      const data = (await res.json()) as { data?: { id?: string } };
      return {
        status: 'pending',
        withdrawalId: data.data?.id || `coinbase-${Date.now()}`,
        exchangeTxId: data.data?.id,
      };
    } catch (err) {
      return {
        status: 'failed',
        withdrawalId: `coinbase-${Date.now()}`,
      };
    }
  }

  private async handleKraken(req: CexWithdrawalRequest): Promise<CexWithdrawalResponse> {
    const path = '/0/private/Withdraw';

    try {
      const { body, headers } = this.signKraken(path, {
        asset: req.sourceAsset.toUpperCase(),
        key: req.targetCAddress,
        amount: toWholeUnits(req.amount, req.sourceAsset),
      });

      const res = await this.postToExchange(
        `${config.cex.kraken.baseUrl}${path}`,
        headers,
        body,
      );

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`kraken withdrawal failed (${res.status}): ${text}`);
      }

      const data = (await res.json()) as { result?: { refid?: string } };
      return {
        status: 'pending',
        withdrawalId: data.result?.refid || `kraken-${Date.now()}`,
        exchangeTxId: data.result?.refid,
      };
    } catch (err) {
      return {
        status: 'failed',
        withdrawalId: `kraken-${Date.now()}`,
      };
    }
  }

  private async handleGeneric(req: CexWithdrawalRequest): Promise<CexWithdrawalResponse> {
    const url = `${config.cex.generic.baseUrl}/withdraw`;
    const body = JSON.stringify({
      asset: req.sourceAsset.toUpperCase(),
      amount: toWholeUnits(req.amount, req.sourceAsset),
      address: req.targetCAddress,
      network: req.targetNetwork,
      memo: req.memo,
    });

    try {
      const res = await this.postToExchange(
        url,
        {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.cex.generic.apiKey}`,
        },
        body,
      );

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`generic withdrawal failed (${res.status}): ${text}`);
      }

      const data = (await res.json()) as { id?: string };
      return {
        status: 'pending',
        withdrawalId: data.id || `generic-${Date.now()}`,
        exchangeTxId: data.id,
      };
    } catch (err) {
      return {
        status: 'failed',
        withdrawalId: `generic-${Date.now()}`,
      };
    }
  }
}
