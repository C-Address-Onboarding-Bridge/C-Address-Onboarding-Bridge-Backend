/** Configuration for a registered exchange integration. */
export interface CexConfig {
  name: string;
  apiBaseUrl: string;
  apiKey?: string;
  apiSecret?: string;
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
  const prefix = exchangeName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const addrSuffix = targetCAddress.slice(-8);
  return `bridge:${prefix}:${addrSuffix}`;
}

/**
 * Parses a bridge memo string into its components.
 * Returns an empty object if the memo does not follow the `bridge:{exchange}:{suffix}` format.
 *
 * @param memo - Memo string from a Stellar transaction.
 */
export function parseCexWithdrawalMemo(memo: string): {
  exchangeName?: string;
  targetSuffix?: string;
} {
  const parts = memo.split(':');
  if (parts.length === 3 && parts[0] === 'bridge') {
    return { exchangeName: parts[1], targetSuffix: parts[2] };
  }
  return {};
}

/**
 * Stub handlers for Binance, Coinbase, and Kraken.
 * These return placeholder responses and do not make real API calls.
 *
 * TODO: replace each stub with a real implementation that calls the exchange's
 * withdrawal API using credentials from `config.apiKey` / `config.apiSecret`.
 */
export const defaultCexHandlers: Record<string, WithdrawalHandler> = {
  async binance(_req, _config) {
    return {
      success: true,
      withdrawalId: `bin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'pending',
      estimatedCompletion: '5-30 minutes',
    };
  },

  async coinbase(_req, _config) {
    return {
      success: true,
      withdrawalId: `cb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'pending',
      estimatedCompletion: '5-30 minutes',
    };
  },

  async kraken(_req, _config) {
    return {
      success: true,
      withdrawalId: `kr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'pending',
      estimatedCompletion: '5-30 minutes',
    };
  },
};
