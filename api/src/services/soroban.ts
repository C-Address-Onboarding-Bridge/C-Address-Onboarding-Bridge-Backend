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
  ): Promise<{ fee: string; feeBps: number; rebateBps: number }> {
    const { feeBps, rebateBps } = await this.getContractFeeBps(sourceAddress);
    const effectiveBps = Math.max(0, feeBps - rebateBps);
    const amountBig = BigInt(amount);
    const fee = (amountBig * BigInt(effectiveBps)) / BigInt(BASIS_POINTS_DENOM);
    return { fee: fee.toString(), feeBps, rebateBps };
  }

  /**
   * Prepares an unsigned funding transaction for the client to sign.
   *
   * Builds a `fund_c_address` invocation, simulates it to obtain the required
   * footprint and fee, and returns the unsigned envelope.
   */
  async prepareFundingTransaction(params: {
    source: string;
    target: string;
    amount: string;
  }): Promise<PreparedFundingTx> {
    return tracer.startActiveSpan('contract.prepareFunding', async (span) => {
      try {
        const contract = new Contract(this.contractId);
        const sourceAccount = await rpcPool.execute((server) =>
          server.getAccount(params.source),
        );

        const tx = new TransactionBuilder(sourceAccount, {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(
            contract.call(
              'fund_c_address',
              new Address(params.source).toScVal(),
              new Address(params.target).toScVal(),
              xdr.ScVal.scvI128(
                new xdr.Int128Parts({
                  hi: xdr.Int64.fromString('0'),
                  lo: xdr.Uint64.fromString(params.amount),
                }),
              ),
            ),
          )
          .setTimeout(30)
          .build();

        const simulation = await rpcPool.execute((server) => server.simulateTransaction(tx));
        if (!SorobanService.isSimulationSuccess(simulation)) {
          throw new SorobanSimulationError('Funding simulation failed');
        }

        const prepared = SorobanService.assembleTransaction(tx, simulation);
        return {
          unsignedXdr: prepared.toXDR(),
          footprint: JSON.stringify(simulation.result?.footprint ?? {}),
          fee: prepared.fee,
        };
      } finally {
        span.end();
      }
    });
  }

  /**
   * Submits a signed single funding transaction after validating its XDR.
   *
   * @param signedXdr - Base64-encoded signed transaction envelope.
   */
  async submitFundingTransaction(signedXdr: string): Promise<SorobanTxResponse> {
    validateXdr(signedXdr, { endpoint: 'fund' });
    return this.submitTransaction(signedXdr);
  }

  /**
   * Submits a signed batch funding transaction after validating its XDR.
   *
   * @param signedXdr - Base64-encoded signed transaction envelope.
   */
  async submitBatchFundingTransaction(signedXdr: string): Promise<SorobanTxResponse> {
    validateXdr(signedXdr, { endpoint: 'batch' });
    return this.submitTransaction(signedXdr);
  }

  /**
   * Submits a signed transaction to the Soroban RPC and records its time
   * bounds so a later `NOT_FOUND` can be classified as `expired`.
   */
  async submitTransaction(signedXdr: string): Promise<SorobanTxResponse> {
    return tracer.startActiveSpan('contract.submitTransaction', async (span) => {
      const start = Date.now();
      try {
        const tx = new Transaction(signedXdr, this.networkPassphrase);
        const hash = tx.hash().toString('hex');
        submittedTxTimeBounds.set(hash, {
          maxTime: tx.timeBounds?.maxTime ? Number(tx.timeBounds.maxTime) : 0,
          submittedAt: Math.floor(Date.now() / 1000),
        });

        const response = await rpcPool.execute((server) => server.sendTransaction(tx));
        if (response.status === 'TRY_AGAIN_LATER') {
          throw new SorobanRetryableError();
        }
        if (response.status === 'ERROR') {
          return { status: 'failed', hash, error: response.errorResult?.toXDR('base64') };
        }
        return { status: 'pending', hash };
      } catch (err) {
        if (err instanceof SorobanRetryableError) throw err;
        throw new SorobanRpcError('Soroban submitTransaction failed', { cause: err });
      } finally {
        externalCallDuration.record(Date.now() - start, { call: 'submitTransaction' });
        span.end();
      }
    });
  }

  /**
   * Polls the RPC for the final status of a submitted transaction.
   */
  async getTransactionStatus(hash: string): Promise<SorobanTxResponse> {
    return tracer.startActiveSpan('contract.getTransactionStatus', async (span) => {
      try {
        const response = await rpcPool.execute((server) => server.getTransaction(hash));
        if (response.status === 'SUCCESS') {
          submittedTxTimeBounds.delete(hash);
          return { status: 'success', hash };
        }
        if (response.status === 'FAILED') {
          submittedTxTimeBounds.delete(hash);
          return { status: 'failed', hash };
        }

        // NOT_FOUND — decide whether the tx's validity window has elapsed.
        const tracked = submittedTxTimeBounds.get(hash);
        const nowSec = Math.floor(Date.now() / 1000);
        if (tracked) {
          const expiry = tracked.maxTime || tracked.submittedAt + DEFAULT_RPC_RETENTION_SECONDS;
          if (nowSec >= expiry) {
            submittedTxTimeBounds.delete(hash);
            return { status: 'expired', hash };
          }
        }
        return { status: 'pending', hash };
      } catch (err) {
        throw new SorobanRpcError('Soroban getTransaction failed', { cause: err });
      } finally {
        span.end();
      }
    });
  }

  /** Type guard for a successful Soroban simulation response. */
  static isSimulationSuccess(simulation: unknown): simulation is {
    result?: { retval?: xdr.ScVal; footprint?: unknown };
  } {
    return (
      typeof simulation === 'object' &&
      simulation !== null &&
      'result' in simulation &&
      !('error' in simulation)
    );
  }

  /** Assembles a simulated transaction into a prepared envelope. */
  static assembleTransaction(
    tx: Transaction,
    simulation: { result?: { retval?: xdr.ScVal; footprint?: unknown } },
  ): Transaction {
    // Minimal assembly: attach the simulated footprint/fee via the SDK helper
    // when available; otherwise return the original transaction.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { SorobanRpc } = require('@stellar/stellar-sdk');
      if (SorobanRpc?.assembleTransaction) {
        return SorobanRpc.assembleTransaction(tx, simulation).build();
      }
    } catch {
      // fall through
    }
    return tx;
  }
}

export const sorobanService = new SorobanService();
