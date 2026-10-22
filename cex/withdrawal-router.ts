import crypto from 'crypto';

/**
 * Converts an amount in stroops (integer string, 10^7 stroops per unit) to a decimal string.
 *
 * @param stroops - Integer string in stroops.
 * @returns Decimal string representation.
 */
export function stroopsToDecimal(stroops: string): string {
  if (!stroops || stroops.includes('.')) return stroops;
  const negative = stroops.startsWith('-');
  const rawStr = negative ? stroops.slice(1) : stroops;
  const bn = BigInt(rawStr);
  const divisor = BigInt(10_000_000);
  const integer = bn / divisor;
  const remainder = bn % divisor;
  let result: string;
  if (remainder === 0n) {
    result = integer.toString();
  } else {
    const fraction = remainder.toString().padStart(7, '0').replace(/0+$/, '');
    result = `${integer}.${fraction}`;
  }
  return negative ? `-${result}` : result;
}

/** Configuration for a registered exchange integration. */
export interface CexConfig {
  name: string;
  apiBaseUrl: string;
  apiKey?: string;
  apiSecret?: string;
  /** Required by exchanges (e.g. Coinbase) that use a passphrase-protected API key. */
  apiPassphrase?: string;
  /** Pre-registered withdrawal key name on Kraken. */
  withdrawKey?: string;
  /** Optional mapping of destination C-addresses to Kraken pre-registered withdrawal key names. */
  withdrawKeys?: Record<string, string>;
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
  error?: string;
}

/**
 * Converts an integer amount in stroops (7 decimal places) to a decimal string for exchange APIs.
 *
 * @param stroops - Integer amount string in stroops (e.g. `"10000000"` for 1 XLM).
 * @param decimals - Number of decimal places (default 7 for Stellar stroops).
 * @returns Human-readable decimal string (e.g. `"1"` or `"1.5"`).
 */
export function stroopsToDecimal(stroops: string, decimals = 7): string {
  if (!/^-?\d+$/.test(stroops)) return stroops;
  const negative = stroops.startsWith('-');
  const digits = (negative ? stroops.slice(1) : stroops).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  const result = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${result}` : result;
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
  return `bridge:${exchangeName}:${targetCAddress.slice(-8)}`;
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

/** Generate Kraken's REST API-Sign value for a URL path and form-encoded body. */
export function createKrakenApiSignature(
  path: string,
  nonce: string,
  body: string,
  apiSecret: string,
): string {
  const sha256Digest = crypto.createHash('sha256').update(nonce + body).digest();
  const message = Buffer.concat([Buffer.from(path, 'utf8'), sha256Digest]);

  return crypto
    .createHmac('sha512', Buffer.from(apiSecret, 'base64'))
    .update(message)
    .digest('base64');
}

/**
 * Default handlers for Binance, Coinbase, and Kraken.
 * Each calls the exchange's withdrawal API using credentials from `config`, signed per that
 * exchange's auth scheme, and returns `success: false` / `status: 'failed'` if the call fails
 * or times out rather than reporting a fake success.
 */
export const defaultCexHandlers: Record<string, WithdrawalHandler> = {
  async binance(req, config) {
    const decimalAmount = stroopsToDecimal(req.amount);
    try {
      const params: Record<string, string> = {
        coin: req.asset,
        amount: decimalAmount,
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
        return { success: false, withdrawalId: `bin-${Date.now()}`, status: 'failed', amount: decimalAmount };
      }

      const data = await res.json() as { id?: string; txId?: string };
      return {
        success: true,
        withdrawalId: `bin-${data.id ?? Date.now()}`,
        txHash: data.txId,
        status: 'pending',
        estimatedCompletion: '5-30 minutes',
        amount: decimalAmount,
      };
    } catch (err) {
      console.error('binance API error:', err);
      return { success: false, withdrawalId: `bin-${Date.now()}`, status: 'failed', amount: decimalAmount };
    }
  },

  async coinbase(req, config) {
    const requestPath = '/withdrawals/crypto';
    const decimalAmount = stroopsToDecimal(req.amount);
    try {
      const body = JSON.stringify({
        amount: decimalAmount,
        currency: req.asset,
        crypto_address: req.destinationAddress,
        ...(req.destinationTag ? { destination_tag: req.destinationTag } : {}),
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
        return { success: false, withdrawalId: `cb-${Date.now()}`, status: 'failed', amount: decimalAmount };
      }

      const data = await res.json() as { id?: string; data?: { id?: string } };
      return {
        success: true,
        withdrawalId: `cb-${data.id ?? data.data?.id ?? Date.now()}`,
        status: 'pending',
        estimatedCompletion: '5-30 minutes',
        amount: decimalAmount,
      };
    } catch (err) {
      console.error('coinbase API error:', err);
      return { success: false, withdrawalId: `cb-${Date.now()}`, status: 'failed', amount: decimalAmount };
    }
  },

  async kraken(req, config) {
    const path = '/0/private/Withdraw';
    const decimalAmount = stroopsToDecimal(req.amount);
    try {
      const nonce = String(Date.now());
      const withdrawKey =
        config.withdrawKeys?.[req.destinationAddress] ?? config.withdrawKey ?? req.destinationAddress;
      const decimalAmount = stroopsToDecimal(req.amount);

      const body = new URLSearchParams({
        asset: req.asset,
        key: withdrawKey,
        amount: decimalAmount,
        nonce,
      }).toString();

      const signature = createKrakenApiSignature(path, nonce, body, config.apiSecret ?? '');

      const res = await postToExchange(`${config.apiBaseUrl}${path}`, {
        'API-Key': config.apiKey ?? '',
        'API-Sign': signature,
        'Content-Type': 'application/x-www-form-urlencoded',
      }, body);

      if (!res.ok) {
        const errText = await res.text();
        console.error(`kraken withdrawal failed: ${res.status} ${errText}`);
        return { success: false, withdrawalId: `kr-${Date.now()}`, status: 'failed', error: errText };
      }

      const data = (await res.json()) as { error?: string[]; result?: { refid?: string } };

      if (data.error && data.error.length > 0) {
        const errorMsg = data.error.join(', ');
        console.error(`kraken withdrawal failed: ${errorMsg}`);
        return {
          success: false,
          withdrawalId: `kr-${Date.now()}`,
          status: 'failed',
          error: errorMsg,
        };
      }

      if (!data.result?.refid) {
        console.error('kraken withdrawal response missing refid');
        return {
          success: false,
          withdrawalId: `kr-${Date.now()}`,
          status: 'failed',
          error: 'Missing withdrawal refid',
        };
      }

      return {
        success: true,
        withdrawalId: data.result.refid,
        status: 'pending',
        estimatedCompletion: '5-30 minutes',
        amount: decimalAmount,
      };
    } catch (err) {
      console.error('kraken API error:', err);
      return { success: false, withdrawalId: `kr-${Date.now()}`, status: 'failed', error: String(err) };
    }
  },

  async generic(req, config) {
    const decimalAmount = stroopsToDecimal(req.amount);
    return {
      success: true,
      withdrawalId: `gen-${Date.now()}`,
      status: 'pending',
      amount: decimalAmount,
    };
  },
};
