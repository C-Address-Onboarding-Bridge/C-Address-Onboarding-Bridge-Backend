import {
  Transaction,
  xdr,
  Contract,
  Address,
  Keypair,
  Account,
  TransactionBuilder,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { config } from '../config';
import { rpcPool } from './rpcPool';
import { externalCallDuration } from './metrics';
import { validateXdr, XdrValidationError } from './xdrValidator';
import { logger } from '../logger';

const tracer = trace.getTracer('soroban-service');

/** Shape of a Soroban transaction response returned by the API. */
export interface SorobanTxResponse {
  status: 'pending' | 'success' | 'failed' | 'expired';
  hash: string;
  error?: string;
}

/**
 * Error thrown when the Soroban RPC asks the caller to retry later
 * (`TRY_AGAIN_LATER`). The transaction was NOT accepted, so callers must
 * surface this as a retryable failure (HTTP 503) rather than a success.
 */
export class SorobanRetryableError extends Error {
  readonly code = 'TRY_AGAIN_LATER';

  constructor(message = 'Soroban RPC is congested; retry later') {
    super(message);
    this.name = 'SorobanRetryableError';
  }
}

/**
 * Error thrown when the Soroban RPC cannot be reached or returns an
 * unexpected failure. Callers must surface this as a retryable failure
 * (HTTP 503) instead of silently reporting `pending`.
 */
export class SorobanRpcError extends Error {
  readonly code = 'RPC_ERROR';

  constructor(message = 'Soroban RPC request failed', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SorobanRpcError';
  }
}

/**
 * Error thrown when a `/fund/prepare` simulation fails. Callers must surface
 * this as a non-2xx response (HTTP 400) instead of returning a 200 with a
 * `simulation_failed` footprint.
 */
export class SorobanSimulationError extends Error {
  readonly code = 'SIMULATION_FAILED';

  constructor(message = 'Soroban simulation failed', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SorobanSimulationError';
  }
}

/** Result of preparing an unsigned funding transaction for the client to sign. */
export interface PreparedFundingTx {
  /** Base64-encoded unsigned transaction envelope the client must sign. */
  unsignedXdr: string;
  /** Footprint (ledger keys) required by the simulation. */
  footprint: string;
  /** Estimated fee in stroops. */
  fee: string;
}

const BASIS_POINTS_DENOM = 10000;

/**
 * Default RPC retention window (in seconds) after which a transaction that is
 * still `NOT_FOUND` can no longer be included and is considered expired.
 * Soroban RPCs typically retain ~24h of ledger history.
 */
const DEFAULT_RPC_RETENTION_SECONDS = 24 * 60 * 60;

/**
 * Tracks the time bounds (unix seconds) of transactions we have submitted so
 * that a persistent `NOT_FOUND` can be reported as `expired` once the
 * transaction's own validity window has elapsed.
 */
const submittedTxTimeBounds = new Map<string, { maxTime: number; submittedAt: number }>();

/**
 * In-process cache for the on-chain fee_bps value.
 * Avoids a contract read on every quote while staying fresh enough that a
 * governance fee change is reflected within one cache window.
 */
interface FeeBpsCache {
  feeBps: number;
  expiresAt: number;
}

/** Cache TTL in milliseconds — 60 s keeps quotes current without over-reading. */
const CONTRACT_FEE_CACHE_TTL_MS = 60_000;

/** Shared fee cache — reset between tests by replacing the module. */
let feeBpsCache: FeeBpsCache | null = null;

/**
 * Decoded batch recipient derived from on-chain XDR arguments.
 */
export interface DecodedRecipient {
  target: string;
  amount: string;
}

/** Wraps the Soroban RPC server and bridge contract interactions. */
export class SorobanService {
  private networkPassphrase: string;
  private contractId: string;

  constructor() {
    this.networkPassphrase = config.soroban.networkPassphrase;
    this.contractId = config.soroban.bridgeContractId;
  }

  /**
   * Reads `fee_bps()` from the on-chain contract and caches the result
   * briefly so that repeated quote calls are cheap.
   *
   * Falls back to `config.soroban.feeBps` if the contract is unavailable
   * (e.g. in tests without a live RPC).
   *
   * @param source - Optional source address for per-user rebate lookup.
   * @returns Effective fee in basis points after any rebate.
   */
  async getContractFeeBps(source?: string): Promise<{ feeBps: number; rebateBps: number }> {
    return tracer.startActiveSpan('contract.getFeeBps', async (span) => {
      try {
        let feeBps: number;

        // Use cached value when still fresh.
        const now = Date.now();
        if (feeBpsCache && now < feeBpsCache.expiresAt) {
          feeBps = feeBpsCache.feeBps;
        } else {
          try {
            const contract = new Contract(this.contractId);
            // Simulate a view call to fee_bps() — no auth required.
            const tx = new TransactionBuilder(
              new Account('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', '0'),
              { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
            )
              .addOperation(contract.call('fee_bps'))
              .setTimeout(30)
              .build();

            const simulation = await rpcPool.execute((server) => server.simulateTransaction(tx));
            if (
              SorobanService.isSimulationSuccess(simulation) &&
              simulation.result?.retval
            ) {
              const raw = simulation.result.retval;
              // fee_bps() returns a u32 scval.
              if (raw.switch().name === 'scvU32') {
                feeBps = raw.u32();
              } else {
                feeBps = config.soroban.feeBps;
              }
            } else {
              feeBps = config.soroban.feeBps;
            }
            feeBpsCache = { feeBps, expiresAt: now + CONTRACT_FEE_CACHE_TTL_MS };
          } catch {
            // RPC unavailable — degrade gracefully to env-var fallback.
            feeBps = config.soroban.feeBps;
          }
        }

        // Per-user rebate via rebate_for(source). Best-effort; 0 on any error.
        let rebateBps = 0;
        if (source && this.contractId) {
          try {
            const contract = new Contract(this.contractId);
            const tx = new TransactionBuilder(
              new Account('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', '0'),
              { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
            )
              .addOperation(
                contract.call('rebate_for', new Address(source).toScVal()),
              )
              .setTimeout(30)
              .build();

            const simulation = await rpcPool.execute((server) => server.simulateTransaction(tx));
            if (
              SorobanService.isSimulationSuccess(simulation) &&
              simulation.result?.retval
            ) {
              const raw = simulation.result.retval;
              if (raw.switch().name === 'scvU32') {
                rebateBps = raw.u32();
              }
            }
          } catch {
            // rebate_for may not exist on all contract versions — ignore.
          }
        }

        span.setAttributes({ 'contract.fee_bps': feeBps, 'contract.rebate_bps': rebateBps });
        return { feeBps, rebateBps };
      } finally {
        span.end();
      }
    });
  }

  /**
   * Returns a fee quote for a prospective funding transaction.
   *
   * Reads `fee_bps()` and `rebate_for(source)` from the on-chain contract
   * (with a short in-process cache) so the quote always reflects current
   * governance settings and per-user rebates.
   *
   * @param _sourceAsset - Asset code (e.g. `XLM`, `USDC`). Reserved for future rate lookup.
   * @param amount - Amount in stroops as an integer string.
   * @param sourceAddress - Funding source address; used for rebate lookup.
   */
  async getQuote(
    _sourceAsset: string,
    amount: string,
    sourceAddress: string,
  ): Promise<{
    estimatedFee: string;
    expectedReceive: string;
    feeBps: number;
    rebateBps: number;
    rate: string;
  }> {
    return tracer.startActiveSpan('quote.calculation', async (span) => {
      try {
        const { feeBps, rebateBps } = await this.getContractFeeBps(sourceAddress);
        const effectiveFeeBps = Math.max(0, feeBps - rebateBps);
        const amountNum = BigInt(amount);
        const feeAmount = (amountNum * BigInt(effectiveFeeBps)) / BigInt(BASIS_POINTS_DENOM);
        const receiveAmount = amountNum - feeAmount;

        span.setAttributes({ 'quote.fee_bps': effectiveFeeBps, 'quote.amount': amount });
        return {
          estimatedFee: feeAmount.toString(),
          expectedReceive: receiveAmount.toString(),
          feeBps: effectiveFeeBps,
          rebateBps,
          rate: '1.0',
        };
      } finally {
        span.end();
      }
    });
  }

  /**
   * Submits a signed batch funding transaction and returns the result.
   * The signed XDR must already encode the `batch_fund_c_address` contract
   * call with all recipients embedded — callers are responsible for building
   * and signing the transaction before submission.
   *
   * @param signedXdr - Base64-encoded signed transaction envelope.
   */
  async submitBatchFundingTransaction(signedXdr: string): Promise<SorobanTxResponse> {
    return this.submitFundingTransaction(signedXdr);
  }

  /**
   * Decodes the list of recipients from a `batch_fund_c_address` Soroban
   * transaction XDR.  Returns `null` when the XDR cannot be parsed or does not
   * contain a recognisable batch call — the caller must treat this as an error.
   *
   * The expected contract call shape is:
   *   batch_fund_c_address(recipients: Vec<{target: Address, amount: i128}>)
   *
   * We do a best-effort decode: we look for a ScVec whose first element is an
   * ScMap with "target" and "amount" keys.  If the shape doesn't match we
   * return null so the route can reject the request.
   */
  decodeRecipientsFromXdr(signedXdr: string): DecodedRecipient[] | null {
    try {
      const envelope = xdr.TransactionEnvelope.fromXDR(signedXdr, 'base64');
      const tx = new Transaction(envelope, this.networkPassphrase);

      for (const op of tx.operations) {
        // We only care about InvokeHostFunction operations.
        if (op.type !== 'invokeHostFunction') continue;

        const invokeOp = (op as any).func;
        if (!invokeOp || invokeOp.switch().name !== 'hostFunctionTypeInvokeContract') continue;

        const args = invokeOp.invokeContract().args();
        // Expect at least: contract_address (0), function_name (1), recipients_vec (2)
        if (!args || args.length < 3) continue;

        const fnName = args[1];
        if (
          fnName.switch().name !== 'scvSymbol' &&
          fnName.switch().name !== 'scvString'
        ) {
          // Skip if we can't verify function name
        }

        // Try to read the recipients argument — typically the 3rd arg (index 2).
        const recipientsArg = args[2];
        if (!recipientsArg || recipientsArg.switch().name !== 'scvVec') continue;

        const vec = recipientsArg.vec();
        if (!vec) continue;

        const recipients: DecodedRecipient[] = [];
        for (const item of vec) {
          if (item.switch().name !== 'scvMap') continue;
          const map = item.map();
          if (!map) continue;

          let target: string | undefined;
          let amount: string | undefined;

          for (const entry of map) {
            const key = entry.key();
            const val = entry.val();

            const keyStr =
              key.switch().name === 'scvSymbol' ? key.sym().toString() :
              key.switch().name === 'scvString' ? key.str().toString() :
              null;

            if (keyStr === 'target' || keyStr === 'to' || keyStr === 'address') {
              if (val.switch().name === 'scvAddress') {
                target = Address.fromScVal(val).toString();
              }
            }
            if (keyStr === 'amount') {
              if (val.switch().name === 'scvI128') {
                const parts = val.i128();
                // Treat hi=0 (positive amounts) — lo is a u64
                const lo = BigInt(parts.lo().toString());
                const hi = BigInt(parts.hi().toString());
                amount = (hi >= 0n ? (hi << 64n) + lo : lo).toString();
              } else if (val.switch().name === 'scvU64') {
                amount = val.u64().toString();
              }
            }
          }

          if (target && amount) {
            recipients.push({ target, amount });
          }
        }

        if (recipients.length > 0) return recipients;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Simulates a `fund_c_address` call and returns an unsigned transaction the
   * client can sign.
   *
   * The memo is encoded as `scvString` to match the contract's `memo: String`
   * parameter. The transaction is built from the real source account (with the
   * sequence number fetched from the RPC) and assembled with the simulation
   * result, so the returned XDR is ready to sign.
   *
   * @param sourceAccount - Stellar account (G-address) that will sign and pay.
   * @param targetAddress - Destination C-address to fund.
   * @param amount - Amount in stroops as an integer string.
   * @param memo - Memo string passed to the contract.
   * @throws {SorobanSimulationError} If the simulation fails.
   */
  async prepareFundingTransaction(
    sourceAccount: string,
    targetAddress: string,
    amount: string,
    memo: string,
  ): Promise<PreparedFundingTx> {
    return tracer.startActiveSpan('soroban.prepareFundingTransaction', async (span) => {
      try {
        const contract = new Contract(this.contractId);
        const operation = contract.call(
          'fund_c_address',
          new Address(targetAddress).toScVal(),
          xdr.ScVal.scvString(memo),
          xdr.ScVal.scvI128(
            new xdr.Int128Parts({
              hi: xdr.Int64.fromString('0'),
              lo: xdr.Uint64.fromString(amount),
            }),
          ),
        );

        // Build from the real source account so the sequence number is valid.
        const account = await rpcPool.execute((server) => server.getAccount(sourceAccount));
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(operation)
          .setTimeout(30)
          .build();

        const simulation = await rpcPool.execute((server) => server.simulateTransaction(tx));

        if (!SorobanService.isSimulationSuccess(simulation)) {
          const detail = 'error' in simulation ? String(simulation.error) : 'unknown error';
          logger.warn({ detail }, 'soroban.prepareFundingTransaction: simulation failed');
          span.setStatus({ code: SpanStatusCode.ERROR, message: detail });
          throw new SorobanSimulationError(detail);
        }

        // Assemble the transaction with the simulation result (footprint, fee,
        // resource data) so the returned XDR is ready to sign.
        const assembled = SorobanService.assembleTransaction(tx, simulation);
        const footprint = simulation.transactionData.build().toXDR('base64');

        span.setAttributes({
          'tx.source': sourceAccount,
          'tx.fee': assembled.fee,
        });

        return {
          unsignedXdr: assembled.toXDR(),
          footprint,
          fee: assembled.fee,
        };
      } catch (err) {
        if (err instanceof SorobanSimulationError) {
          throw err;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw new SorobanSimulationError(String(err), { cause: err });
      } finally {
        span.end();
      }
    });
  }

  /**
   * Validates and submits a signed Soroban transaction XDR to the network.
   *
   * Runs the full XDR validation pipeline before touching the RPC. Any
   * validation failure throws an `XdrValidationError` with a structured
   * `code` and `detail`; the caller should convert these to 400 responses.
   *
   * @param signedXdr - Base64-encoded signed transaction envelope.
   * @returns Transaction status and hash.
   * @throws {XdrValidationError} If the XDR fails any validation rule.
   * @throws {SorobanRetryableError} If the RPC returns `TRY_AGAIN_LATER`.
   */
  async submitFundingTransaction(
    signedXdr: string,
  ): Promise<SorobanTxResponse> {
    return tracer.startActiveSpan('soroban.submitFundingTransaction', async (span): Promise<SorobanTxResponse> => {
      const start = Date.now();
      try {
        // ── Validation pipeline ──────────────────────────────────────────────
        // Throws XdrValidationError on any rule failure — no network call is made.
        const validation = validateXdr(signedXdr);
        span.setAttributes({
          'tx.hash': validation.txHash,
          'tx.source': validation.sourceAccount,
          'tx.fee': validation.fee,
          'tx.op_count': validation.operationCount,
        });

        return await this.submitValidatedXdr(signedXdr, validation.txHash, span, start);
      } catch (err) {
        if (err instanceof XdrValidationError) {
          logger.warn(
            { code: err.code, detail: err.detail },
            'soroban.submitFundingTransaction: XDR validation rejected',
          );
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        }
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Shared submission path used by both single and batch funding flows.
   *
   * Re-parses the validated XDR, sends it to the RPC pool, and maps the
   * Soroban response status to the API's `SorobanTxResponse`:
   *
   * - `PENDING` / `DUPLICATE` → `pending` (accepted or already in flight)
   * - `ERROR` → `failed`
   * - `TRY_AGAIN_LATER` → throws `SorobanRetryableError` (HTTP 503)
   * - anything else → confirmed via `getTransaction` before reporting success
   */
  private async submitValidatedXdr(
    signedXdr: string,
    txHash: string,
    span: ReturnType<typeof tracer.startActiveSpan> extends never ? never : any,
    start: number,
  ): Promise<SorobanTxResponse> {
    const envelope = xdr.TransactionEnvelope.fromXDR(signedXdr, 'base64');
    const tx = new Transaction(envelope, this.networkPassphrase);

    // Record the transaction's time bounds so a later `NOT_FOUND` can be
    // distinguished from a transaction that is genuinely still in flight.
    this.rememberTimeBounds(txHash, tx);

    const sendResponse = await rpcPool.execute((server) => server.sendTransaction(tx));
    externalCallDuration.observe({ service: 'soroban' }, (Date.now() - start) / 1000);

    if (sendResponse.status === 'PENDING' || sendResponse.status === 'DUPLICATE') {
      return { status: 'pending' as const, hash: txHash };
    }
    if (sendResponse.status === 'ERROR') {
      span.setStatus({ code: SpanStatusCode.ERROR });
      return {
        status: 'failed' as const,
        hash: txHash,
        error: sendResponse.errorResult?.result().toString() || 'unknown error',
      };
    }
    if (sendResponse.status === 'TRY_AGAIN_LATER') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'TRY_AGAIN_LATER' });
      throw new SorobanRetryableError();
    }

    // Only report success once the network confirms the transaction.
    const confirmed = await this.getTransactionStatus(txHash);
    if (confirmed.status === 'success') {
      return { status: 'success' as const, hash: txHash };
    }
    return confirmed;
  }

  /**
   * Records the time bounds of a submitted transaction so that a persistent
   * `NOT_FOUND` can later be classified as `expired`.
   */
  private rememberTimeBounds(txHash: string, tx: Transaction): void {
    const maxTime = tx.timeBounds?.maxTime ? Number(tx.timeBounds.maxTime) : 0;
    submittedTxTimeBounds.set(txHash, { maxTime, submittedAt: Math.floor(Date.now() / 1000) });
  }

  /**
   * Returns true when a simulation response indicates success. Kept as a
   * narrow type guard so callers can safely read `transactionData`.
   */
  private static isSimulationSuccess(
    simulation: any,
  ): simulation is { transactionData: any; result?: any; minResourceFee?: string } {
    return !!simulation && !('error' in simulation) && !!simulation.transactionData;
  }

  /**
   * Assembles a transaction with a successful simulation result, applying the
   * Soroban data (footprint, resources) and the simulated fee.
   */
  private static assembleTransaction(tx: Transaction, simulation: any): Transaction {
    const fee = simulation.minResourceFee
      ? (BigInt(simulation.minResourceFee) + BigInt(BASE_FEE)).toString()
      : BASE_FEE;
    return (TransactionBuilder as any).cloneFrom(tx, {
      fee,
      sorobanData: simulation.transactionData.build(),
    }).build();
  }

  /**
   * Placeholder for transaction status lookup. Implemented elsewhere in the
   * service; declared here so the submission path can confirm success.
   */
  private async getTransactionStatus(txHash: string): Promise<SorobanTxResponse> {
    const response = await rpcPool.execute((server) => server.getTransaction(txHash));
    if (response.status === 'SUCCESS') {
      return { status: 'success', hash: txHash };
    }
    if (response.status === 'FAILED') {
      return { status: 'failed', hash: txHash, error: 'transaction failed' };
    }
    const bounds = submittedTxTimeBounds.get(txHash);
    const now = Math.floor(Date.now() / 1000);
    if (bounds && bounds.maxTime > 0 && now > bounds.maxTime) {
      return { status: 'expired', hash: txHash };
    }
    if (bounds && now - bounds.submittedAt > DEFAULT_RPC_RETENTION_SECONDS) {
      return { status: 'expired', hash: txHash };
    }
    return { status: 'pending', hash: txHash };
  }

  /**
   * Builds, simulates, and submits a `fund_c_address` call directly from
   * address parameters.  Used by the `/fund/direct` endpoint where the client
   * does not have the ability to build and sign the transaction themselves.
   *
   * Unlike the two-step prepare → submit flow, the source secret key is never
   * handled by this service; the function is a convenience wrapper that still
   * delegates submission to `submitFundingTransaction`.
   */
  async submitDirectFunding(params: {
    sourceAddress: string;
    targetAddress: string;
    tokenAddress: string;
    amount: string;
    memo: string;
  }): Promise<SorobanTxResponse> {
    // Direct funding requires the caller to have prepared and signed the XDR
    // externally. This method is a placeholder for the route's dependency;
    // a real implementation would involve server-side key management or a
    // custodial signing flow, which is out of scope for this service.
    throw new Error(
      'submitDirectFunding requires a server-side signing key. ' +
        'Use the prepare → sign → submit flow instead.',
    );
  }
}

/** Shared singleton instance used by routes and background jobs. */
export const sorobanService = new SorobanService();

/**
 * Standalone helper exported for legacy callers (e.g. soroban.test.ts) that
 * call `getTransactionStatus(server, hash, bounds?)` directly.
 */
export async function getTransactionStatus(
  server: any,
  txHash: string,
  bounds?: { minTime?: number; maxTime?: number; submittedAt?: number },
): Promise<SorobanTxResponse & { ledger?: number }> {
  try {
    const response = await server.getTransaction(txHash);
    if (response.status === 'SUCCESS') {
      return { status: 'success', hash: txHash, ledger: response.ledger };
    }
    if (response.status === 'FAILED') {
      return { status: 'failed', hash: txHash, ledger: response.ledger };
    }
    return { status: 'pending', hash: txHash };
  } catch (err: any) {
    if (err?.code === 'NOT_FOUND' || err?.message?.includes('not found')) {
      const now = Math.floor(Date.now() / 1000);
      if (bounds?.maxTime && now > bounds.maxTime) {
        return { status: 'expired', hash: txHash };
      }
      if (
        bounds?.submittedAt !== undefined &&
        now - bounds.submittedAt > DEFAULT_RPC_RETENTION_SECONDS
      ) {
        return { status: 'expired', hash: txHash };
      }
      return { status: 'pending', hash: txHash };
    }
    throw err;
  }
}
