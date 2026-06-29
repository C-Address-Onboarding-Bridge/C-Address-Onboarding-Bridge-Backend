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
  RequestOptions,
  FundingPrepareResult,
  HttpMethod,
} from "./types";
import { SimpleCache } from "./cache";
import { TelemetryClient } from "./telemetry";
import {
  parseHttpError,
  NetworkError,
  TimeoutError,
  BridgeError,
} from "./errors";

const REQUEST_TIMEOUT_MS = 30_000;

export type { BridgeClientConfig } from "./types";
import type { BridgeClientConfig } from "./types";

// ─── HMAC-SHA256 signing helpers ───────────────────────────────────────────────

async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── BridgeClient ─────────────────────────────────────────────────────────────

export class BridgeClient {
  private readonly config: BridgeClientConfig;
  private readonly cache: SimpleCache;
  private readonly telemetry: TelemetryClient;
  private readonly metrics = { totalRequests: 0 };
  private readonly defaultTimeout: number;
  private readonly fundSubmissionTimeout: number;
  private baseUrl: string;
  private apiKey?: string;
  private retryConfig: Required<NonNullable<BridgeClientConfig["retry"]>>;

  constructor(config: BridgeClientConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.defaultTimeout = REQUEST_TIMEOUT_MS;
    this.fundSubmissionTimeout = REQUEST_TIMEOUT_MS * 2;
    this.cache = new SimpleCache({ maxEntries: config.cache?.maxEntries });
    this.telemetry = new TelemetryClient(config.telemetry ?? {});
    this.retryConfig = {
      maxRetries: config.retry?.maxRetries ?? 3,
      baseDelayMs: config.retry?.baseDelayMs ?? 100,
      maxDelayMs: config.retry?.maxDelayMs ?? 5000,
      retryBudgetMs: config.retry?.retryBudgetMs ?? 10_000,
      jitterMs: config.retry?.jitterMs ?? 50,
      logger: config.retry?.logger ?? console,
    };
  }

  private shouldRetry(err: unknown): boolean {
    if (err instanceof DOMException && err.name === "AbortError") return false;
    if (err instanceof Error && err.name === "AbortError") return false;
    if (err instanceof BridgeError) return err.retryable;
    // Non-bridge errors (network-level) are retryable
    return true;
  }

  private computeDelay(attempt: number): number {
    const exponential = this.retryConfig.baseDelayMs * 3 ** attempt;
    const capped = Math.min(exponential, this.retryConfig.maxDelayMs);
    const jitter = Math.floor(
      Math.random() * this.retryConfig.jitterMs * 2 - this.retryConfig.jitterMs,
    );
    return Math.max(0, capped + jitter);
  }

  private async buildSigningHeaders(
    bodyStr: string,
  ): Promise<Record<string, string>> {
    if (!this.config.signing?.enabled || !this.apiKey) return {};

    const timestamp = String(Date.now());
    const nonce = generateNonce();
    const payload = `${bodyStr}.${timestamp}.${nonce}`;
    const signature = await hmacSha256Hex(this.apiKey, payload);

    return {
      "X-Timestamp": timestamp,
      "X-Nonce": nonce,
      "X-Signature": `sha256=${signature}`,
    };
  }

  protected async request<T>(
    method: HttpMethod,
    path: string,
    body?: Record<string, unknown>,
    params?: RequestParams,
    options?: RequestOptions,
  ): Promise<T> {
    const timeoutMs = options?.timeout ?? this.defaultTimeout;
    this.metrics.totalRequests++;

    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, val] of Object.entries(params)) {
        if (val !== undefined) {
          url.searchParams.set(key, String(val));
        }
      }
    }

    const bodyStr = body ? JSON.stringify(body) : "";
    const signingHeaders = await this.buildSigningHeaders(bodyStr);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...signingHeaders,
    };
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;

    let attempt = 0;
    const startedAt = Date.now();

    while (true) {
      const controller = new AbortController();
      const abortTimeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url.toString(), {
          method,
          headers,
          body: bodyStr || undefined,
          signal: controller.signal,
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          const bridgeErr = parseHttpError(
            res.status,
            errBody as {
              message?: string;
              code?: string;
              fields?: Record<string, string>;
              retryAfter?: number;
            },
          );
          if (
            bridgeErr.retryable &&
            attempt < this.retryConfig.maxRetries &&
            Date.now() - startedAt < this.retryConfig.retryBudgetMs
          ) {
            attempt += 1;
            this.retryConfig.logger.debug?.(
              `retrying ${method} ${path} attempt ${attempt} after ${res.status}`,
            );
            await this.delay(this.computeDelay(attempt - 1));
            continue;
          }
          throw bridgeErr;
        }

        return res.json() as Promise<T>;
      } catch (error) {
        // Re-wrap abort as TimeoutError
        if (
          (error instanceof DOMException || error instanceof Error) &&
          error.name === "AbortError"
        ) {
          throw new TimeoutError(`${method} ${path}`, timeoutMs);
        }
        // Re-wrap network failures
        if (
          error instanceof TypeError &&
          !(error instanceof Error && "statusCode" in error)
        ) {
          const netErr = new NetworkError(error.message, { cause: error });
          if (
            this.shouldRetry(netErr) &&
            attempt < this.retryConfig.maxRetries &&
            Date.now() - startedAt < this.retryConfig.retryBudgetMs
          ) {
            attempt += 1;
            this.retryConfig.logger.debug?.(
              `retrying ${method} ${path} attempt ${attempt} after network error`,
            );
            await this.delay(this.computeDelay(attempt - 1));
            continue;
          }
          throw netErr;
        }
        if (
          this.shouldRetry(error) &&
          attempt < this.retryConfig.maxRetries &&
          Date.now() - startedAt < this.retryConfig.retryBudgetMs
        ) {
          attempt += 1;
          this.retryConfig.logger.debug?.(
            `retrying ${method} ${path} attempt ${attempt} after error`,
          );
          await this.delay(this.computeDelay(attempt - 1));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(abortTimeout);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async requestPaginated<T>(
    path: string,
    params?: PaginatedRequestParams,
  ): Promise<PaginatedResponse<T>> {
    const queryParams: RequestParams = {};
    if (params?.cursor !== undefined) queryParams["cursor"] = params.cursor;
    if (params?.limit !== undefined)
      queryParams["limit"] = String(params.limit);
    if (params?.offset !== undefined)
      queryParams["offset"] = String(params.offset);
    return this.request<PaginatedResponse<T>>(
      "GET",
      path,
      undefined,
      queryParams,
    );
  }

  async getQuote(params: QuoteParams): Promise<Quote> {
    const cacheKey = `quote:${params.sourceAsset}:${params.amount}:${params.targetAddress}`;
    const cached = this.cache.get<Quote>(cacheKey);
    if (cached) {
      return cached.value;
    }

    const startedAt = Date.now();
    try {
      const result = await this.request<Quote>(
        "GET",
        "/api/v1/quote",
        undefined,
        {
          sourceAsset: params.sourceAsset,
          amount: params.amount,
          targetAddress: params.targetAddress,
        },
      );
      this.cache.set(
        cacheKey,
        result,
        this.getTtl("quote"),
        this.shouldUseStaleWhileRevalidate(),
      );
      this.telemetry.record({
        method: "getQuote",
        responseTimeMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.telemetry.record({
        method: "getQuote",
        responseTimeMs: Date.now() - startedAt,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  }

  async submitSignedXdr(
    params: FundWithXdrParams,
    options?: RequestOptions,
  ): Promise<FundingResult> {
    return this.request<FundingResult>(
      "POST",
      "/api/v1/fund",
      { signedXdr: params.signedXdr },
      undefined,
      { timeout: this.fundSubmissionTimeout, ...options },
    );
  }

  async prepareFundingTransaction(
    params: FundParams,
  ): Promise<FundingPrepareResult> {
    return this.request<FundingPrepareResult>("POST", "/api/v1/fund/prepare", {
      sourceAddress: params.sourceAddress,
      targetAddress: params.targetAddress,
      tokenAddress: params.tokenAddress,
      amount: params.amount,
      memo: params.memo || "",
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
      const result = await this.request<TransactionStatus>(
        "GET",
        `/api/v1/status/${txHash}`,
      );
      this.cache.set(
        cacheKey,
        result,
        this.getTtl("status"),
        this.shouldUseStaleWhileRevalidate(),
      );
      this.telemetry.record({
        method: "getStatus",
        responseTimeMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.telemetry.record({
        method: "getStatus",
        responseTimeMs: Date.now() - startedAt,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  }

  async createMoonpayUrl(
    params: MoonpayWidgetParams,
    options?: RequestOptions,
  ): Promise<MoonpayWidgetResult> {
    return this.request<MoonpayWidgetResult>(
      "POST",
      "/api/v1/offramp/moonpay",
      params as unknown as Record<string, unknown>,
      undefined,
      options,
    );
  }

  async createTransakUrl(
    params: TransakWidgetParams,
    options?: RequestOptions,
  ): Promise<TransakWidgetResult> {
    return this.request<TransakWidgetResult>(
      "POST",
      "/api/v1/offramp/transak",
      params as unknown as Record<string, unknown>,
      undefined,
      options,
    );
  }

  async health(): Promise<{ status: string }> {
    const cacheKey = "health";
    const cached = this.cache.get<{ status: string }>(cacheKey);
    if (cached) {
      return cached.value;
    }

    const startedAt = Date.now();
    try {
      const result = await this.request<{ status: string }>("GET", "/health");
      this.cache.set(
        cacheKey,
        result,
        this.getTtl("health"),
        this.shouldUseStaleWhileRevalidate(),
      );
      this.telemetry.record({
        method: "health",
        responseTimeMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.telemetry.record({
        method: "health",
        responseTimeMs: Date.now() - startedAt,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  }

  async routeCexWithdrawal(
    params: CexWithdrawalParams,
  ): Promise<CexWithdrawalResult> {
    return this.request<CexWithdrawalResult>(
      "POST",
      "/api/v1/cex/route",
      params as unknown as Record<string, unknown>,
    );
  }

  invalidateQuoteCache(params: QuoteParams): void {
    const cacheKey = `quote:${params.sourceAsset}:${params.amount}:${params.targetAddress}`;
    this.cache.invalidate(cacheKey);
  }

  private getTtl(kind: "quote" | "status" | "health"): number {
    const defaults = { quote: 15_000, status: 5_000, health: 30_000 } as const;
    return this.getCacheOption(kind, defaults[kind]);
  }

  private getCacheOption(
    kind: "quote" | "status" | "health",
    fallback: number,
  ): number {
    if (!this.config.cache) return fallback;

    switch (kind) {
      case "quote":
        return this.config.cache.quoteTtlMs ?? fallback;
      case "status":
        return this.config.cache.statusTtlMs ?? fallback;
      case "health":
        return this.config.cache.healthTtlMs ?? fallback;
      default:
        return fallback;
    }
  }

  private shouldUseStaleWhileRevalidate(): boolean {
    return this.config.cache?.staleWhileRevalidate ?? true;
  }

  /**
   * Run comprehensive diagnostics to identify common integration issues
   */
  async runDiagnostics(options?: {
    checkApiKey?: boolean;
    checkConnectivity?: boolean;
    checkContractStatus?: boolean;
    targetAddress?: string;
  }): Promise<{
    status: "healthy" | "degraded" | "unhealthy";
    checks: {
      apiKey?: { status: "pass" | "fail"; message: string };
      connectivity?: {
        status: "pass" | "fail";
        latency?: number;
        message?: string;
      };
      contractStatus?: {
        status: "pass" | "fail";
        version?: string;
        message?: string;
      };
      addressValidation?: {
        status: "pass" | "fail";
        addressType?: string;
        message?: string;
      };
    };
    timestamp: string;
  }> {
    const checks: {
      apiKey?: { status: "pass" | "fail"; message: string };
      connectivity?: {
        status: "pass" | "fail";
        latency?: number;
        message?: string;
      };
      contractStatus?: {
        status: "pass" | "fail";
        version?: string;
        message?: string;
      };
      addressValidation?: {
        status: "pass" | "fail";
        addressType?: string;
        message?: string;
      };
    } = {};

    let allPassed = true;

    // Check API Key
    if (options?.checkApiKey !== false) {
      try {
        await this.health();
        checks.apiKey = { status: "pass", message: "API key is valid" };
      } catch (error) {
        allPassed = false;
        checks.apiKey = {
          status: "fail",
          message:
            error instanceof Error
              ? error.message
              : "API key validation failed",
        };
      }
    }

    // Check Connectivity
    if (options?.checkConnectivity !== false) {
      const start = Date.now();
      try {
        await this.health();
        const latency = Date.now() - start;
        checks.connectivity = { status: "pass", latency, message: undefined };
      } catch (error) {
        allPassed = false;
        checks.connectivity = {
          status: "fail",
          latency: undefined,
          message:
            error instanceof Error
              ? error.message
              : "Connectivity check failed",
        };
      }
    }

    // Check Contract Status (using a quote request as proxy)
    if (options?.checkContractStatus !== false) {
      try {
        // Make a minimal quote request to verify contract is accessible
        await this.getQuote({
          sourceAsset: "XLM",
          amount: "10000000",
          targetAddress:
            options?.targetAddress ||
            "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        });
        checks.contractStatus = {
          status: "pass",
          version: undefined,
          message: undefined,
        };
      } catch (error) {
        allPassed = false;
        checks.contractStatus = {
          status: "fail",
          version: undefined,
          message:
            error instanceof Error
              ? error.message
              : "Contract status check failed",
        };
      }
    }

    // Check Address Validation
    if (options?.targetAddress) {
      const address = options.targetAddress;
      const isValid = /^[GC][A-Z2-7]{55}$/.test(address);
      if (isValid) {
        const isCAddress = address.startsWith("C");
        const isGAddress = address.startsWith("G");
        checks.addressValidation = {
          status: "pass",
          addressType: isCAddress
            ? "C-address"
            : isGAddress
              ? "G-address"
              : "unknown",
          message: undefined,
        };
      } else {
        allPassed = false;
        checks.addressValidation = {
          status: "fail",
          addressType: undefined,
          message: "Invalid Stellar address format",
        };
      }
    }

    return {
      status: allPassed ? "healthy" : "unhealthy",
      checks,
      timestamp: new Date().toISOString(),
    };
  }
}
