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

/**
 * Returns true if the hash has already been recorded as seen. This is a pure
 * read — it does NOT record the hash. Recording is deferred until the RPC has
 * actually accepted the transaction (see `recordSeenHash`), so a failed
 * submission (RPC down, TRY_AGAIN_LATER, etc.) does not poison the cache and
 * block the client's retry of the same signed transaction.
 */
export function hasSeenHash(txHash: string): boolean {
  return seenHashes.has(txHash);
}

/**
 * Records a transaction hash as seen. Call this only after the RPC has accepted
 * the transaction (status PENDING or DUPLICATE), never before submission.
 */
export function recordSeenHash(txHash: string): void {
  seenHashes.set(txHash, true);
}

// ── Stellar address helper ────────────────────────────────────────────────────

function isValidStellarAddress(addr: string): boolean {
  return STELLAR_ADDRESS_REGEX.test(addr);
}

// ── Rule implementations ──────────────────────────────────────────────────────

export function checkSize(xdrString: string, maxByteLength: number = MAX_XDR_BYTE_LENGTH): void {
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
 * `TransactionBuilder.fromXDR` accepts a base64 string or a decoded
 * `xdr.TransactionEnvelope` — NOT a raw `Buffer`. Passing a Buffer makes the
 * SDK treat it as an envelope object and fail with
 * `envelope.switch is not a function`, rejecting every XDR as
 * `XDR_PARSE_FAILED`. We therefore decode the buffer into an
 * `xdr.TransactionEnvelope` and hand that to the builder.
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
    const envelope = xdr.TransactionEnvelope.fromXDR(rawBuf);
    parsed = TransactionBuilder.fromXDR(envelope, networkPassphrase);
  } catch (err) {
    throw new XdrValidationError(
      'XDR_PARSE_FAILED',
      `XDR envelope could not be decoded: ${(err as Error).message}`,
    );
  }

  if (parsed instanceof FeeBumpTransaction) {
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
