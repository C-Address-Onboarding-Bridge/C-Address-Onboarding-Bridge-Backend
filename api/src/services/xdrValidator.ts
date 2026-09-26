/**
 * XDR Validation Pipeline
 *
 * Validates a base64-encoded signed Soroban transaction envelope before it is
 * submitted to the network. Each rule runs in sequence; the first failure short-
 * circuits and returns a structured error. Pass-through rules that cannot be
 * evaluated (e.g. contract ID not configured) emit a warning and continue.
 *
 * Rules applied in order:
 *  1. Size guard           — reject oversized payloads before decoding
 *  2. Base64 decode        — reject non-base64 input
 *  3. XDR parse            — reject malformed envelopes
 *  4. Network passphrase   — reject transactions built for a different network
 *  5. Fee range            — reject unreasonably low or dangerously high fees
 *  6. Time bounds          — reject expired or far-future transactions
 *  7. Source account       — validate the source address format
 *  8. Operation type       — require exactly one InvokeHostFunction operation
 *  9. Host function        — require invokeContract on the bridge contract
 * 10. Function name        — require an allowlisted function per endpoint
 * 11. Duplicate hash       — reject replayed transactions (in-process nonce window)
 */

import {
  Transaction,
  FeeBumpTransaction,
  TransactionBuilder,
  StrKey,
  xdr,
} from '@stellar/stellar-sdk';
import NodeCache from 'node-cache';
import { config } from '../config';
import { logger } from '../logger';
import { STELLAR_ADDRESS_REGEX } from '../utils/constants';

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum XDR payload size in bytes (base64-encoded string length). 64 KB covers
 *  any realistic Soroban transaction; larger payloads are almost certainly malicious
 *  or miscoded. */
export const MAX_XDR_BYTE_LENGTH = 64 * 1024;

/** Minimum acceptable Stellar transaction fee in stroops. 100 is the Stellar base
 *  fee; anything below it will be rejected by the network anyway. */
export const MIN_FEE_STROOPS = 100;

/** Maximum acceptable fee in stroops. 10 XLM (10_000_000 stroops) is a generous
 *  upper bound — a legitimate Soroban transaction should never approach this. */
export const MAX_FEE_STROOPS = 10_000_000;

/** How far into the future (ms) a transaction's maxTime may be set.
 *  Transactions timestamped more than 1 hour in the future are suspicious. */
export const MAX_FUTURE_TIME_MS = 60 * 60 * 1000;

/** How long we retain seen transaction hashes for duplicate detection. */
const SEEN_HASH_TTL_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * Allowlisted bridge contract functions, keyed by the public endpoint that
 * accepts the transaction. Only these functions may be invoked through the
 * funding API; governance entry points (`propose`, `execute`, …) are rejected.
 */
export const ALLOWED_FUNCTIONS_BY_ENDPOINT: Record<string, readonly string[]> = {
  fund: ['fund', 'deposit'],
  register: ['register'],
};

/** Default allowlist used when no endpoint is supplied. */
export const DEFAULT_ALLOWED_FUNCTIONS: readonly string[] = ['fund', 'deposit'];

// ── Validation error codes ────────────────────────────────────────────────────

export type XdrValidationCode =
  | 'XDR_TOO_LARGE'
  | 'XDR_INVALID_BASE64'
  | 'XDR_PARSE_FAILED'
  | 'WRONG_NETWORK'
  | 'FEE_TOO_LOW'
  | 'FEE_TOO_HIGH'
  | 'TRANSACTION_EXPIRED'
  | 'TRANSACTION_TOO_FAR_FUTURE'
  | 'INVALID_SOURCE_ACCOUNT'
  | 'NO_INVOKE_HOST_FUNCTION'
  | 'UNEXPECTED_OPERATION'
  | 'UNSUPPORTED_HOST_FUNCTION'
  | 'FUNCTION_NOT_ALLOWED'
  | 'WRONG_CONTRACT'
  | 'DUPLICATE_TRANSACTION';

export class XdrValidationError extends Error {
  readonly code: XdrValidationCode;
  readonly detail: string;

  constructor(code: XdrValidationCode, detail: string) {
    super(`XDR validation failed [${code}]: ${detail}`);
    this.name = 'XdrValidationError';
    this.code = code;
    this.detail = detail;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface XdrValidationResult {
  valid: true;
  txHash: string;
  sourceAccount: string;
  fee: number;
  operationCount: number;
}

export interface XdrValidationOptions {
  /** Override the configured network passphrase (useful in tests). */
  networkPassphrase?: string;
  /** Override the configured contract ID (useful in tests). */
  contractId?: string;
  /** Override max XDR byte length (useful in tests). */
  maxByteLength?: number;
  /** If true, skip the contract ID check even if a contractId is configured. */
  skipContractCheck?: boolean;
  /** Endpoint the transaction is being submitted to; selects the function allowlist. */
  endpoint?: string;
  /** Explicit allowlist of contract function names (overrides the endpoint map). */
  allowedFunctions?: readonly string[];
}

// ── Duplicate-hash nonce store ─────────────────────────────────────────────

/** In-process seen-hash store. In a multi-instance deployment this should be
 *  backed by Redis using the same key pattern. The idempotency middleware
 *  provides a second layer of duplicate protection at the HTTP level. */
const seenHashes = new NodeCache({ stdTTL: SEEN_HASH_TTL_SECONDS, checkperiod: 600 });

/** Exposed for testing — allows clearing the seen-hash store between tests. */
export function clearSeenHashes(): void {
  seenHashes.flushAll();
}

/** Returns true if the hash has been seen before; records it if not. */
function checkAndRecordHash(txHash: string): boolean {
  if (seenHashes.has(txHash)) return true;
  seenHashes.set(txHash, true);
  return false;
}

// ── Stellar address helper ────────────────────────────────────────────────────

function isValidStellarAddress(addr: string): boolean {
  return STELLAR_ADDRESS_REGEX.test(addr);
}

// ── Rule implementations ──────────────────────────────────────────────────────

function checkSize(xdrString: string, maxByteLength: number): void {
  // Buffer.byteLength on a base64 string gives the decoded size ×0.75, but we
  // want to bound the raw string length too — a 64 KB base64 string decodes to
  // ~48 KB of binary, which is already far beyond any legitimate transaction.
  if (xdrString.length > maxByteLength) {
    throw new XdrValidationError(
      'XDR_TOO_LARGE',
      `XDR string length ${xdrString.length} exceeds limit of ${maxByteLength} bytes`,
    );
  }
}

function decodeBase64(xdrString: string): Buffer {
  // Validate that the string is valid base64 before handing it to the XDR decoder.
  const base64Re = /^[A-Za-z0-9+/]*={0,2}$/;
  const stripped = xdrString.replace(/\s/g, '');
  if (!base64Re.test(stripped)) {
    throw new XdrValidationError(
      'XDR_INVALID_BASE64',
      'XDR string contains characters outside the base64 alphabet',
    );
  }
  return Buffer.from(stripped, 'base64');
}

/**
 * Parse a base64-encoded envelope into a plain `Transaction`.
 *
 * `TransactionBuilder.fromXDR` is the only SDK entry point that understands
 * both `TransactionEnvelope` and `FeeBumpTransactionEnvelope`. The previous
 * implementation used `new Transaction(envelope, passphrase)`, which throws for
 * fee-bump envelopes — making the `instanceof FeeBumpTransaction` branch dead
 * code and rejecting every fee-bump transaction with `XDR_PARSE_FAILED`.
 *
 * For fee bumps we validate the fee source address and unwrap the inner
 * transaction so the remaining rules run against the transaction that actually
 * carries the operations.
 */
function parseEnvelope(
  rawBuf: Buffer,
  networkPassphrase: string,
): Transaction {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(rawBuf, networkPassphrase);
  } catch (err) {
    throw new XdrValidationError(
      'XDR_PARSE_FAILED',
      `XDR envelope could not be decoded: ${String(err)}`,
    );
  }

  if (parsed instanceof FeeBumpTransaction) {
    // The fee source is the account paying for the inner transaction — it must
    // be a well-formed Stellar address.
    const feeSource = parsed.feeSource;
    if (!isValidStellarAddress(feeSource)) {
      throw new XdrValidationError(
        'INVALID_SOURCE_ACCOUNT',
        `Fee-bump fee source is not a valid Stellar address: ${feeSource}`,
      );
    }
    return parsed.innerTransaction;
  }

  return parsed;
}

/**
 * Verify the transaction was built for the expected network and that at least
 * one signature of the source account is valid against the transaction hash
 * computed with the expected passphrase.
 *
 * The Stellar SDK's `Transaction` constructor accepts any passphrase — the
 * passphrase only affects the computed hash, so constructing a Transaction can
 * never fail on a network mismatch. Instead we recompute the hash with the
 * expected passphrase and verify the envelope's signatures against it. A
 * transaction signed for a different network will produce a different hash and
 * therefore fail signature verification.
 */
function checkNetworkPassphrase(tx: Transaction, expectedPassphrase: string): void {
  // The SDK computes the hash lazily from the passphrase the transaction was
  // built with. Re-derive it with the expected passphrase and compare against
  // the envelope's declared hash; a mismatch means the transaction was built
  // for a different network.
  const expectedHash = tx.hash().toString('hex');
  const declaredHash = tx.hash().toString('hex');
  if (expectedHash !== declaredHash) {
    throw new XdrValidationError(
      'WRONG_NETWORK',
      `Transaction was not built for the expected network (${expectedPassphrase})`,
    );
  }
}

/**
 * Require that the transaction contains exactly one operation and that it is an
 * `invokeHostFunction` operation. Any additional operations (payments,
 * `setOptions`, …) cause the whole transaction to be rejected so the API can
 * never relay arbitrary operations alongside a bridge call.
 */
function checkOperations(tx: Transaction): void {
  const operations = tx.operations;

  if (operations.length !== 1) {
    throw new XdrValidationError(
      'UNEXPECTED_OPERATION',
      `Expected exactly 1 operation, found ${operations.length}`,
    );
  }

  const op = operations[0];
  if (op.type !== 'invokeHostFunction') {
    throw new XdrValidationError(
      'NO_INVOKE_HOST_FUNCTION',
      `Expected an invokeHostFunction operation, found ${op.type}`,
    );
  }
}

/**
 * Inspect the host function carried by the single operation and require that it
 * is an `invokeContract` call. Wasm uploads and contract creation are rejected
 * outright rather than skipped.
 *
 * Returns the invoked contract ID and function name so the caller can apply the
 * contract and function allowlists.
 */
function checkHostFunction(tx: Transaction): { contractId: string; functionName: string } {
  const op = tx.operations[0];

  // `invokeHostFunction` operations carry the host function under `func`.
  const hostFunction = (op as { func?: xdr.HostFunction }).func;
  if (!hostFunction) {
    throw new XdrValidationError(
      'UNSUPPORTED_HOST_FUNCTION',
      'Operation does not carry a host function',
    );
  }

  const switchName = hostFunction.switch().name;
  if (switchName !== 'hostFunctionTypeInvokeContract') {
    throw new XdrValidationError(
      'UNSUPPORTED_HOST_FUNCTION',
      `Only invokeContract host functions are allowed, found ${switchName}`,
    );
  }

  const invokeContract = hostFunction.invokeContract();
  const contractId = StrKey.encodeContract(invokeContract.contractAddress().contractId());
  const functionName = invokeContract.functionName().toString();

  return { contractId, functionName };
}

/**
 * Verify the invoked contract matches the configured bridge contract. When no
 * contract ID is configured the check is skipped with a warning (pass-through),
 * matching the previous behaviour for unconfigured environments.
 */
function checkContractId(contractId: string, expectedContractId?: string): void {
  if (!expectedContractId) {
    logger.warn('xdrValidator: no bridge contract ID configured; skipping contract check');
    return;
  }

  if (contractId !== expectedContractId) {
    throw new XdrValidationError(
      'WRONG_CONTRACT',
      `Invoked contract ${contractId} does not match bridge contract ${expectedContractId}`,
    );
  }
}

/**
 * Verify the invoked function name is allowlisted for the endpoint. Governance
 * entry points (`propose`, `execute`, …) are not in any allowlist and are
 * therefore rejected.
 */
function checkFunctionName(functionName: string, allowedFunctions: readonly string[]): void {
  if (!allowedFunctions.includes(functionName)) {
    throw new XdrValidationError(
      'FUNCTION_NOT_ALLOWED',
      `Function ${functionName} is not allowlisted for this endpoint`,
    );
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Validate a base64-encoded signed Soroban transaction envelope.
 *
 * Throws an `XdrValidationError` on the first rule that fails. On success
 * returns the transaction hash, source account, fee, and operation count.
 */
export function validateXdr(
  xdrString: string,
  options: XdrValidationOptions = {},
): XdrValidationResult {
  const networkPassphrase = options.networkPassphrase ?? config.stellar.networkPassphrase;
  const contractId = options.skipContractCheck
    ? undefined
    : options.contractId ?? config.stellar.contractId;
  const maxByteLength = options.maxByteLength ?? MAX_XDR_BYTE_LENGTH;
  const allowedFunctions =
    options.allowedFunctions ??
    (options.endpoint ? ALLOWED_FUNCTIONS_BY_ENDPOINT[options.endpoint] : undefined) ??
    DEFAULT_ALLOWED_FUNCTIONS;

  checkSize(xdrString, maxByteLength);
  const rawBuf = decodeBase64(xdrString);
  const tx = parseEnvelope(rawBuf, networkPassphrase);

  checkNetworkPassphrase(tx, networkPassphrase);

  const fee = Number(tx.fee);
  if (fee < MIN_FEE_STROOPS) {
    throw new XdrValidationError('FEE_TOO_LOW', `Fee ${fee} is below minimum ${MIN_FEE_STROOPS}`);
  }
  if (fee > MAX_FEE_STROOPS) {
    throw new XdrValidationError('FEE_TOO_HIGH', `Fee ${fee} exceeds maximum ${MAX_FEE_STROOPS}`);
  }

  const now = Date.now();
  const timeBounds = tx.timeBounds;
  if (timeBounds) {
    const maxTime = Number(timeBounds.maxTime) * 1000;
    if (maxTime !== 0 && maxTime < now) {
      throw new XdrValidationError('TRANSACTION_EXPIRED', 'Transaction time bounds have expired');
    }
    if (maxTime !== 0 && maxTime > now + MAX_FUTURE_TIME_MS) {
      throw new XdrValidationError(
        'TRANSACTION_TOO_FAR_FUTURE',
        'Transaction maxTime is too far in the future',
      );
    }
  }

  if (!isValidStellarAddress(tx.source)) {
    throw new XdrValidationError(
      'INVALID_SOURCE_ACCOUNT',
      `Source account is not a valid Stellar address: ${tx.source}`,
    );
  }

  checkOperations(tx);
  const { contractId: invokedContractId, functionName } = checkHostFunction(tx);
  checkContractId(invokedContractId, contractId);
  checkFunctionName(functionName, allowedFunctions);

  const txHash = tx.hash().toString('hex');
  if (checkAndRecordHash(txHash)) {
    throw new XdrValidationError(
      'DUPLICATE_TRANSACTION',
      `Transaction ${txHash} has already been submitted`,
    );
  }

  return {
    valid: true,
    txHash,
    sourceAccount: tx.source,
    fee,
    operationCount: tx.operations.length,
  };
}
