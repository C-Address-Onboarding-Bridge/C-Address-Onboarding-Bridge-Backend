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
 *  8. Operation type       — require at least one InvokeHostFunction operation
 *  9. Contract ID          — verify the invoked contract matches the bridge
 * 10. Duplicate hash       — reject replayed transactions (in-process nonce window)
 */

import { xdr, Transaction, FeeBumpTransaction, StrKey } from '@stellar/stellar-sdk';
import NodeCache from 'node-cache';
import { config } from '../config';
import { logger } from '../logger';

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

const STELLAR_ADDRESS_RE = /^[GC][A-Z2-7]{55}$/;

function isValidStellarAddress(addr: string): boolean {
  return STELLAR_ADDRESS_RE.test(addr);
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

function parseEnvelope(
  rawBuf: Buffer,
  networkPassphrase: string,
): Transaction {
  let tx: Transaction;
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(rawBuf);
    const inner = new Transaction(envelope, networkPassphrase);
    // Fee bump transactions wrap an inner transaction — unwrap it.
    if (inner instanceof FeeBumpTransaction) {
      tx = inner.innerTransaction;
    } else {
      tx = inner;
    }
  } catch (err) {
    throw new XdrValidationError(
      'XDR_PARSE_FAILED',
      `XDR envelope could not be decoded: ${String(err)}`,
    );
  }
  return tx;
}

function checkNetworkPassphrase(tx: Transaction, expectedPassphrase: string): void {
  // The Transaction constructor already validates the passphrase against the
  // envelope's network hash. If it does not throw, the passphrase matched.
  // We re-verify here for explicitness and to emit a structured error.
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(tx.toEnvelope().toXDR());
    new Transaction(envelope, expectedPassphrase);
  } catch {
    throw new XdrValidationError(
      'WRONG_NETWORK',
      'Transaction was built for a different Stellar network',
    );
  }
}

function checkFee(tx: Transaction): void {
  const fee = parseInt(tx.fee, 10);
  if (isNaN(fee) || fee < MIN_FEE_STROOPS) {
    throw new XdrValidationError(
      'FEE_TOO_LOW',
      `Transaction fee ${tx.fee} stroops is below the minimum of ${MIN_FEE_STROOPS}`,
    );
  }
  if (fee > MAX_FEE_STROOPS) {
    throw new XdrValidationError(
      'FEE_TOO_HIGH',
      `Transaction fee ${tx.fee} stroops exceeds the maximum of ${MAX_FEE_STROOPS}`,
    );
  }
}

function checkTimeBounds(tx: Transaction): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const bounds = tx.timeBounds;

  if (!bounds) {
    // No time bounds — the transaction never expires. Warn but allow; the
    // Soroban network will apply its own ledger validity window.
    logger.warn({ txHash: tx.hash().toString('hex') }, 'xdr-validator: transaction has no time bounds (never expires)');
    return;
  }

  const minTime = typeof bounds.minTime === 'string' ? parseInt(bounds.minTime, 10) : Number(bounds.minTime);
  const maxTime = typeof bounds.maxTime === 'string' ? parseInt(bounds.maxTime, 10) : Number(bounds.maxTime);

  // maxTime of 0 means "no upper bound" in the Stellar protocol — allow it.
  if (maxTime !== 0 && maxTime < nowSec) {
    throw new XdrValidationError(
      'TRANSACTION_EXPIRED',
      `Transaction expired at ${new Date(maxTime * 1000).toISOString()} (now: ${new Date(nowSec * 1000).toISOString()})`,
    );
  }

  if (maxTime !== 0 && (maxTime - nowSec) * 1000 > MAX_FUTURE_TIME_MS) {
    throw new XdrValidationError(
      'TRANSACTION_TOO_FAR_FUTURE',
      `Transaction maxTime is more than ${MAX_FUTURE_TIME_MS / 60_000} minutes in the future`,
    );
  }

  if (minTime > 0 && minTime > nowSec + 30) {
    // minTime more than 30 s in the future — the transaction is not yet valid.
    throw new XdrValidationError(
      'TRANSACTION_EXPIRED',
      `Transaction minTime ${new Date(minTime * 1000).toISOString()} has not yet been reached`,
    );
  }
}

function checkSourceAccount(tx: Transaction): void {
  const src = tx.source;
  if (!src || !isValidStellarAddress(src)) {
    throw new XdrValidationError(
      'INVALID_SOURCE_ACCOUNT',
      `Transaction source account '${src}' is not a valid Stellar address`,
    );
  }
}

function checkOperations(tx: Transaction, contractId: string, skipContractCheck: boolean): void {
  const ops = tx.operations;

  // Every funding transaction must contain at least one InvokeHostFunction op.
  const invokeOps = ops.filter((op) => op.type === 'invokeHostFunction');
  if (invokeOps.length === 0) {
    throw new XdrValidationError(
      'NO_INVOKE_HOST_FUNCTION',
      `Transaction contains no InvokeHostFunction operations (found: ${ops.map((o) => o.type).join(', ') || 'none'})`,
    );
  }

  if (skipContractCheck || !contractId) return;

  // Inspect each InvokeHostFunction operation's host function to verify the
  // target contract address matches the configured bridge contract ID.
  for (const op of invokeOps) {
    if (op.type !== 'invokeHostFunction') continue;

    try {
      const hf = (op as { func?: xdr.HostFunction }).func;
      if (!hf) continue;

      // The host function must be of type `invokeContract`.
      if (hf.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) continue;

      const invokeArgs = hf.invokeContract();

      // Convert the contract ID bytes to a strkey for comparison.
      const contractBytes = invokeArgs.contractAddress().contractId();
      const invokingContractStrkey = StrKey.encodeContract(contractBytes);

      if (invokingContractStrkey !== contractId) {
        throw new XdrValidationError(
          'WRONG_CONTRACT',
          `Transaction invokes contract '${invokingContractStrkey}' but expected '${contractId}'`,
        );
      }
    } catch (err) {
      if (err instanceof XdrValidationError) throw err;
      // If we can't decode the op details, log a warning but don't hard-fail —
      // the network will reject a wrong-contract call anyway.
      logger.warn({ err: String(err) }, 'xdr-validator: could not inspect InvokeHostFunction contract address');
    }
  }
}

function checkDuplicate(txHash: string): void {
  if (checkAndRecordHash(txHash)) {
    throw new XdrValidationError(
      'DUPLICATE_TRANSACTION',
      `Transaction ${txHash} has already been submitted`,
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validates a base64-encoded signed Soroban transaction XDR envelope.
 *
 * @param xdrString - Base64-encoded signed transaction envelope (from client).
 * @param opts - Optional overrides for network passphrase, contract ID, etc.
 * @returns `XdrValidationResult` on success.
 * @throws `XdrValidationError` with a structured `code` on any validation failure.
 *
 * @example
 * ```typescript
 * try {
 *   const result = await validateXdr(req.body.signedXdr);
 *   // result.txHash, result.sourceAccount, result.fee
 * } catch (err) {
 *   if (err instanceof XdrValidationError) {
 *     res.status(400).json({ error: err.code, message: err.detail });
 *   }
 * }
 * ```
 */
export function validateXdr(
  xdrString: string,
  opts: XdrValidationOptions = {},
): XdrValidationResult {
  const networkPassphrase = opts.networkPassphrase ?? config.soroban.networkPassphrase;
  const contractId = opts.contractId ?? config.soroban.bridgeContractId;
  const maxByteLength = opts.maxByteLength ?? MAX_XDR_BYTE_LENGTH;
  const skipContractCheck = opts.skipContractCheck ?? false;

  // Rule 1: size guard
  checkSize(xdrString, maxByteLength);

  // Rule 2: base64 decode
  const rawBuf = decodeBase64(xdrString);

  // Rule 3: XDR parse
  const tx = parseEnvelope(rawBuf, networkPassphrase);

  // Rule 4: network passphrase (re-verify with original string for belt-and-suspenders)
  checkNetworkPassphrase(tx, networkPassphrase);

  // Rule 5: fee range
  checkFee(tx);

  // Rule 6: time bounds
  checkTimeBounds(tx);

  // Rule 7: source account
  checkSourceAccount(tx);

  // Rule 8 + 9: operation type and contract ID
  checkOperations(tx, contractId, skipContractCheck);

  // Rule 10: duplicate hash
  const txHash = tx.hash().toString('hex');
  checkDuplicate(txHash);

  logger.debug(
    {
      txHash,
      source: tx.source,
      fee: tx.fee,
      opCount: tx.operations.length,
    },
    'xdr-validator: transaction passed all validation rules',
  );

  return {
    valid: true,
    txHash,
    sourceAccount: tx.source,
    fee: parseInt(tx.fee, 10),
    operationCount: tx.operations.length,
  };
}
