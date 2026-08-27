import crypto from 'crypto';

/** Configuration for a registered exchange integration. */
export interface CexConfig {
  name: string;
  apiBaseUrl: string;
  apiKey?: string;
  apiSecret?: string;
  /** Required by exchanges (e.g. Coinbase) that use a passphrase-protected API key. */
  apiPassphrase?: string;
}

/** Withdrawal request to be routed to an exchange. */
export interface WithdrawalRequest {
  /** Destination Stellar or C-address. */
  destinationAddress: string;
  /** Optional destination tag or memo for the exchange. */
  destinationTag?: string;
  /** Asset code (e.g. `XLM`, `USDC`). */
  asset: string;
  /** Amount in stroops as an integer string. */
  amount: string;
  /** Network identifier (e.g. `stellar`). */
  network: string;
}

/** Result returned by an exchange withdrawal handler. */
export interface WithdrawalResult {
  success: boolean;
  withdrawalId: string;
  txHash?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  estimatedCompletion?: string;
}

/**
 * Function signature for a pluggable exchange withdrawal handler.
 * Implementations should call the exchange's withdrawal API and return a {@link WithdrawalResult}.
 */
export type WithdrawalHandler = (req: WithdrawalRequest, config: CexConfig) => Promise<WithdrawalResult>;

/**
 * Pluggable routing engine for CEX withdrawal requests.
 * Register exchange handlers with `registerExchange`, then call `routeWithdrawal` to dispatch.
 *
 * @example
 * const router = new WithdrawalRouter();
 * router.registerExchange('my-exchange', { name: 'my-exchange', apiBaseUrl: 'https://...' }, myHandler);
 * const result = await router.routeWithdrawal('my-exchange', request);
 */
export class WithdrawalRouter {
  private handlers: Map<string, { config: CexConfig; handler: WithdrawalHandler }> = new Map();

  /**
   * Registers an exchange handler.
   * Exchange names are normalised to lowercase.
   *
   * @param name - Exchange identifier (e.g. `"binance"`).
   * @param config - Exchange API base URL and optional credentials.
   * @param handler - Async function that performs the withdrawal.
   */
  registerExchange(name: string, config: CexConfig, handler: WithdrawalHandler) {
    this.handlers.set(name.toLowerCase(), { config, handler });
  }

  /**
   * Dispatches a withdrawal request to the registered handler for the given exchange.
   *
   * @param exchange - Exchange name (case-insensitive).
   * @param request - Withdrawal details.
   * @throws {Error} If no handler is registered for the exchange.
   */
  async routeWithdrawal(exchange: string, request: WithdrawalRequest): Promise<WithdrawalResult> {
    const entry = this.handlers.get(exchange.toLowerCase());
    if (!entry) {
      throw new Error(`unsupported exchange: ${exchange}. supported: ${[...this.handlers.keys()].join(', ')}`);
    }
    return entry.handler(request, entry.config);
  }

  /** Returns the names of all registered exchanges. */
  getSupportedExchanges(): string[] {
    return [...this.handlers.keys()];
  }
}

/**
 * Generates the standard bridge memo string for tracking CEX withdrawals.
 * Format: `bridge:{exchangeName}:{last8CharsOfCAddress}`
 *
 * @param targetCAddress - Destination C-address.
 * @param exchangeName - Exchange identifier.
 */
export function createCexWithdrawalMemo(targetCAddress: string, exchangeName: string): string {
  throw new Error('Not implemented: createCexWithdrawalMemo');
}

/**
 * Parses a bridge memo string into its components.
 * Returns an empty object if the memo does not follow the `bridge:{exchange}:{suffix}` format.
 *
 * @param memo - Memo string from a Stellar transaction.
 */
export function parseCexWithdrawalMemo(memo: string): { exchangeName?: string; targetSuffix?: string } {
  const match = /^bridge:([^:]+):([^:]+)$/.exec(memo);
  if (!match) return {};
  return { exchangeName: match[1], targetSuffix: match[2] };
}

/** POSTs to an exchange endpoint, aborting after 15s so a hung exchange API can't hang the caller. */
async function postToExchange(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    return await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Default handlers for Binance, Coinbase, and Kraken.
 * Each calls the exchange's withdrawal API using credentials from `config`, signed per that
 * exchange's auth scheme, and returns `success: false` / `status: 'failed'` if the call fails
 * or times out rather than reporting a fake success.
 */
export const defaultCexHandlers: Record<string, WithdrawalHandler> = {
  async binance(req, config) {
    try {
      const params: Record<string, string> = {
        coin: req.asset,
        amount: req.amount,
        address: req.destinationAddress,
        network: req.network,
        timestamp: String(Date.now()),
        recvWindow: '5000',
      };
      if (req.destinationTag) params.addressTag = req.destinationTag;

      const query = new URLSearchParams(params).toString();
      const signature = crypto.createHmac('sha256', config.apiSecret ?? '').update(query).digest('hex');

      const res = await postToExchange(
        `${config.apiBaseUrl}/sapi/v1/capital/withdraw/apply?${query}&signature=${signature}`,
        { 'X-MBX-APIKEY': config.apiKey ?? '', 'Content-Type': 'application/x-www-form-urlencoded' },
        '',
      );

      if (!res.ok) {
        console.error(`binance withdrawal failed: ${res.status} ${await res.text()}`);
        return { success: false, withdrawalId: `bin-${Date.now()}`, status: 'failed' };
      }

      const data = await res.json() as { id?: string; txId?: string };
      return {
        success: true,
        withdrawalId: `bin-${data.id ?? Date.now()}`,
        txHash: data.txId,
        status: 'pending',
        estimatedCompletion: '5-30 minutes',
      };
    } catch (err) {
      console.error('binance API error:', err);
      return { success: false, withdrawalId: `bin-${Date.now()}`, status: 'failed' };
    }
  },

  async coinbase(req, config) {
    const requestPath = '/v2/accounts/withdrawals';
    try {
      const body = JSON.stringify({
        type: 'send',
        to: req.destinationAddress,
        amount: req.amount,
        currency: req.asset,
        description: req.destinationTag,
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const prehash = `${timestamp}POST${requestPath}${body}`;
      const signature = crypto
        .createHmac('sha256', Buffer.from(config.apiSecret ?? '', 'base64'))
        .update(prehash)
        .digest('base64');

      const res = await postToExchange(`${config.apiBaseUrl}${requestPath}`, {
        'Content-Type': 'application/json',
        'CB-ACCESS-KEY': config.apiKey ?? '',
        'CB-ACCESS-SIGN': signature,
        'CB-ACCESS-TIMESTAMP': timestamp,
        'CB-ACCESS-PASSPHRASE': config.apiPassphrase ?? '',
      }, body);

      if (!res.ok) {
        console.error(`coinbase withdrawal failed: ${res.status} ${await res.text()}`);
        return { success: false, withdrawalId: `cb-${Date.now()}`, status: 'failed' };
      }

      const data = await res.json() as { data?: { id?: string } };
      return {
        success: true,
        withdrawalId: `cb-${data.data?.id ?? Date.now()}`,
        status: 'pending',
        estimatedCompletion: '5-30 minutes',
      };
    } catch (err) {
      console.error('coinbase API error:', err);
      return { success: false, withdrawalId: `cb-${Date.now()}`, status: 'failed' };
    }
  },

  async kraken(req, config) {
    const path = '/0/private/Withdraw';
    try {
      const nonce = String(Date.now());
      const body = new URLSearchParams({
        asset: req.asset,
        key: req.destinationAddress,
        amount: req.amount,
        nonce,
      }).toString();

      const sha256Hash = crypto.createHash('sha256').update(nonce + body).digest();
      const message = Buffer.concat([Buffer.from(path), sha256Hash]);
      const signature = crypto
        .createHmac('sha512', Buffer.from(config.apiSecret ?? '', 'base64'))
        .update(message)
        .digest('base64');

      const res = await postToExchange(`${config.apiBaseUrl}${path}`, {
        'Content-Type': 'application/x-www-form-urlencoded',
        'API-Key': config.apiKey ?? '',
        'API-Sign': signature,
      }, body);

      if (!res.ok) {
        console.error(`kraken withdrawal failed: ${res.status} ${await res.text()}`);
        return { success: false, withdrawalId: `kr-${Date.now()}`, status: 'failed' };
      }

      const data = await res.json() as { result?: { refid?: string } };
      return {
        success: true,
        withdrawalId: `kr-${data.result?.refid ?? Date.now()}`,
        status: 'pending',
        estimatedCompletion: '5-30 minutes',
      };
    } catch (err) {
      console.error('kraken API error:', err);
      return { success: false, withdrawalId: `kr-${Date.now()}`, status: 'failed' };
    }
  },
};
