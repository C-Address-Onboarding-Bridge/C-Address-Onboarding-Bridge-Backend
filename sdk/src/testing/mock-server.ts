import { fixtures } from './fixtures';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A fetch request captured by the mock server for later assertion. */
export interface RecordedRequest {
  method: string;
  url: string;
  pathname: string;
  searchParams: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
  timestamp: number;
}

type RouteOutcome =
  | { kind: 'reply'; status: number; body: unknown }
  | { kind: 'network-error' }
  | { kind: 'timeout' };

interface RouteConfig {
  outcome: RouteOutcome;
  delayMs: number;
}

interface RegisteredRoute {
  matches: (method: string, pathname: string) => boolean;
  config: RouteConfig;
}

// ─── RouteBuilder ─────────────────────────────────────────────────────────────

/**
 * Fluent builder for configuring a single route's response.
 *
 * Obtain via `server.on*()` methods; do not construct directly.
 */
export class RouteBuilder<TServer extends BridgeMockServer = BridgeMockServer> {
  private pendingDelay = 0;

  constructor(
    private readonly server: TServer,
    private readonly matcher: (method: string, pathname: string) => boolean,
  ) {}

  /** Wait `ms` milliseconds before responding (useful for testing loading states or timeouts). */
  delay(ms: number): this {
    this.pendingDelay = ms;
    return this;
  }

  /** Respond with `status` and a JSON `body`. */
  reply(status: number, body: unknown): TServer {
    this.server._register({
      matches: this.matcher,
      config: { outcome: { kind: 'reply', status, body }, delayMs: this.pendingDelay },
    });
    return this.server;
  }

  /** Respond with an error status and a `{ message }` body. */
  replyError(status: number, message: string): TServer {
    return this.reply(status, fixtures.apiError(message));
  }

  /**
   * Simulate a network-level failure (e.g. connection refused).
   * The SDK will receive a `TypeError` from fetch, which triggers retry logic.
   */
  networkError(): TServer {
    this.server._register({
      matches: this.matcher,
      config: { outcome: { kind: 'network-error' }, delayMs: this.pendingDelay },
    });
    return this.server;
  }

  /**
   * Never respond — the request hangs until the SDK's own timeout fires.
   * Combine with a short `timeout` in `BridgeClientConfig.retry` to test timeout handling.
   */
  timeout(): TServer {
    this.server._register({
      matches: this.matcher,
      config: { outcome: { kind: 'timeout' }, delayMs: this.pendingDelay },
    });
    return this.server;
  }
}

// ─── Default route handlers ───────────────────────────────────────────────────

function buildDefaultHandlers(): RegisteredRoute[] {
  const exact =
    (method: string, path: string) =>
    (m: string, p: string) =>
      m === method && p === path;

  const prefix =
    (method: string, pathPrefix: string) =>
    (m: string, p: string) =>
      m === method && p.startsWith(pathPrefix);

  const reply = (body: unknown): RouteConfig => ({
    outcome: { kind: 'reply', status: 200, body },
    delayMs: 0,
  });

  return [
    { matches: exact('GET', '/api/v1/quote'),       config: reply(fixtures.quote()) },
    { matches: exact('POST', '/api/v1/fund/prepare'), config: reply(fixtures.fundingPrepareResult()) },
    { matches: exact('POST', '/api/v1/fund'),        config: reply(fixtures.fundingResult()) },
    { matches: prefix('GET', '/api/v1/status/'),     config: reply(fixtures.transactionStatus()) },
    { matches: exact('GET', '/health'),              config: reply({ status: 'ok' }) },
    { matches: exact('POST', '/api/v1/cex/route'),   config: reply(fixtures.cexWithdrawalResult()) },
    { matches: exact('POST', '/api/v1/offramp/moonpay'), config: reply(fixtures.moonpayWidgetResult()) },
    { matches: exact('POST', '/api/v1/offramp/transak'), config: reply(fixtures.transakWidgetResult()) },
  ];
}

// ─── BridgeMockServer ─────────────────────────────────────────────────────────

/**
 * In-memory mock server for testing SDK consumers without a real API.
 *
 * Install it before your test and uninstall after to isolate test state:
 *
 * ```ts
 * import { createMockServer } from '@c-address-bridge/sdk/testing';
 *
 * const mock = createMockServer();
 * beforeEach(() => mock.install());
 * afterEach(() => mock.uninstall());
 * ```
 *
 * By default every endpoint returns a realistic fixture response — no setup needed.
 * Override specific routes for targeted scenarios:
 *
 * ```ts
 * mock.onQuote().reply(503, { message: 'Service unavailable' });
 * mock.onStatus('abc123').delay(100).reply(200, fixtures.transactionStatus('success'));
 * mock.onFund().networkError();
 * mock.onStatus().timeout();
 * ```
 *
 * Inspect what the SDK sent:
 * ```ts
 * expect(mock.requests[0].searchParams.amount).toBe('10000');
 * ```
 */
export class BridgeMockServer {
  private overrides: RegisteredRoute[] = [];
  private defaults: RegisteredRoute[] = buildDefaultHandlers();
  private _requests: RecordedRequest[] = [];
  private originalFetch: typeof globalThis.fetch | undefined;

  /** All requests captured since the last `reset()` or `install()`, in order. */
  get requests(): readonly RecordedRequest[] {
    return this._requests;
  }

  /**
   * Replace `globalThis.fetch` with the mock interceptor.
   * Returns `this` for chaining with route setup.
   */
  install(): this {
    this.originalFetch = globalThis.fetch;
    globalThis.fetch = this._interceptFetch.bind(this) as typeof globalThis.fetch;
    return this;
  }

  /** Restore `globalThis.fetch` to its original value. */
  uninstall(): void {
    if (this.originalFetch !== undefined) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = undefined;
    }
  }

  /**
   * Clear all per-test overrides and request history.
   * Default handlers (realistic fixtures) are preserved.
   */
  reset(): this {
    this.overrides = [];
    this._requests = [];
    return this;
  }

  // ─── Route builders ──────────────────────────────────────────────────────

  /** Override the quote endpoint: `GET /api/v1/quote`. */
  onQuote(): RouteBuilder<this> {
    return this._builder('GET', '/api/v1/quote');
  }

  /** Override the funding prepare endpoint: `POST /api/v1/fund/prepare`. */
  onFundPrepare(): RouteBuilder<this> {
    return this._builder('POST', '/api/v1/fund/prepare');
  }

  /** Override the fund (XDR submit) endpoint: `POST /api/v1/fund`. */
  onFund(): RouteBuilder<this> {
    return this._builder('POST', '/api/v1/fund');
  }

  /**
   * Override the status endpoint: `GET /api/v1/status/:txHash`.
   * Pass a specific `txHash` to only match that hash; omit to match any status request.
   */
  onStatus(txHash?: string): RouteBuilder<this> {
    if (txHash !== undefined) {
      return new RouteBuilder(this, (m, p) => m === 'GET' && p === `/api/v1/status/${txHash}`);
    }
    return new RouteBuilder(this, (m, p) => m === 'GET' && p.startsWith('/api/v1/status/'));
  }

  /** Override the health endpoint: `GET /health`. */
  onHealth(): RouteBuilder<this> {
    return this._builder('GET', '/health');
  }

  /** Override the CEX withdrawal routing endpoint: `POST /api/v1/cex/route`. */
  onCexWithdrawal(): RouteBuilder<this> {
    return this._builder('POST', '/api/v1/cex/route');
  }

  /** Override the Moonpay widget URL endpoint: `POST /api/v1/offramp/moonpay`. */
  onMoonpay(): RouteBuilder<this> {
    return this._builder('POST', '/api/v1/offramp/moonpay');
  }

  /** Override the Transak widget URL endpoint: `POST /api/v1/offramp/transak`. */
  onTransak(): RouteBuilder<this> {
    return this._builder('POST', '/api/v1/offramp/transak');
  }

  /**
   * Override any arbitrary endpoint by method and exact path.
   * Useful for paginated endpoints or future endpoints not covered by named helpers.
   *
   * @example
   * mock.onRoute('GET', '/api/v1/txns').reply(200, { data: [], nextCursor: null, hasMore: false });
   */
  onRoute(method: string, path: string): RouteBuilder<this> {
    return this._builder(method.toUpperCase(), path);
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  /** @internal Called by RouteBuilder to register an override. */
  _register(route: RegisteredRoute): void {
    this.overrides.unshift(route); // higher index = checked first (LIFO)
  }

  private _builder(method: string, path: string): RouteBuilder<this> {
    return new RouteBuilder(this, (m, p) => m === method && p === path);
  }

  private async _interceptFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

    const parsedUrl = new URL(urlStr);
    const pathname = parsedUrl.pathname;

    const searchParams: Record<string, string> = {};
    parsedUrl.searchParams.forEach((v, k) => { searchParams[k] = v; });

    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers as HeadersInit);
      h.forEach((v, k) => { headers[k] = v; });
    }

    let body: unknown = undefined;
    if (init?.body && typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }

    this._requests.push({ method, url: urlStr, pathname, searchParams, body, headers, timestamp: Date.now() });

    const route = this._resolve(method, pathname);
    const { outcome, delayMs } = route;

    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }

    if (outcome.kind === 'network-error') {
      throw new TypeError(`[BridgeMockServer] Simulated network error for ${method} ${pathname}`);
    }

    if (outcome.kind === 'timeout') {
      return new Promise<Response>(() => { /* never resolves */ });
    }

    const { status, body: responseBody } = outcome;
    const ok = status >= 200 && status < 300;

    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Mock Error',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(responseBody),
      text: () => Promise.resolve(JSON.stringify(responseBody)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as Response;
  }

  private _resolve(method: string, pathname: string): RouteConfig {
    // Overrides are checked first (LIFO - last registered wins)
    for (const route of this.overrides) {
      if (route.matches(method, pathname)) return route.config;
    }
    // Then fall through to defaults
    for (const route of this.defaults) {
      if (route.matches(method, pathname)) return route.config;
    }
    // Unknown route → 404
    return { outcome: { kind: 'reply', status: 404, body: { message: `No mock for ${method} ${pathname}` } }, delayMs: 0 };
  }
}

/**
 * Create a new `BridgeMockServer` instance.
 *
 * @example
 * const mock = createMockServer();
 * beforeEach(() => mock.install());
 * afterEach(() => { mock.reset(); mock.uninstall(); });
 */
export function createMockServer(): BridgeMockServer {
  return new BridgeMockServer();
}
