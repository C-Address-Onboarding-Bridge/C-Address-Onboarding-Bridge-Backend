import { ValidationError } from './errors';

/**
 * Returns `true` if the string is a valid Stellar address (G-address or C-address).
 * Note: this accepts both account addresses (G…) and contract addresses (C…).
 * Use `isGAddress` / `isCAddress` when you need to distinguish between them.
 */
export function isValidStellarAddress(address: string): boolean {
  // Stellar StrKey addresses are exactly 56 characters long
  if (address.length !== 56) return false;
  // Must start with 'G' (classic account) or 'C' (contract address)
  if (address[0] !== 'G' && address[0] !== 'C') return false;
  // Must only contain valid RFC 4648 base32 characters: A-Z and 2-7
  return /^[A-Z2-7]{56}$/.test(address);
}

/** Returns `true` if the address is a Soroban contract address (starts with `C`). */
export function isCAddress(address: string): boolean {
  return isValidStellarAddress(address) && address.startsWith('C');
}

/** Returns `true` if the address is a classic Stellar account address (starts with `G`). */
export function isGAddress(address: string): boolean {
  return isValidStellarAddress(address) && address.startsWith('G');
}

/**
 * Validates that `feeBps` is an integer in the `[0, 10000]` range (0%–100%).
 *
 * @throws {ValidationError} If `feeBps` is not an integer, or is outside `[0, 10000]`.
 */
function validateFeeBps(feeBps: number): void {
  if (!Number.isInteger(feeBps)) {
    throw new ValidationError(`Invalid feeBps: ${feeBps}. Must be an integer.`, {
      fields: { feeBps: 'must be an integer' },
    });
  }
  if (feeBps < 0 || feeBps > 10000) {
    throw new ValidationError(
      `Invalid feeBps: ${feeBps}. Must be between 0 and 10000 (inclusive).`,
      { fields: { feeBps: 'must be between 0 and 10000' } },
    );
  }
}

/**
 * Calculates the protocol fee for a given amount and fee rate.
 *
 * @param amount - Transfer amount in stroops.
 * @param feeBps - Fee rate in basis points (e.g. `30` = 0.3%). Must be an integer in `[0, 10000]`.
 * @returns Fee in stroops (truncated, not rounded).
 * @throws {ValidationError} If `feeBps` is not an integer, or is outside `[0, 10000]`.
 */
export function calculateFee(amount: bigint, feeBps: number): bigint {
  // #665: Validate feeBps and calculate fee with truncation
  validateFeeBps(feeBps);
  return (amount * BigInt(feeBps)) / BigInt(10000);
}

/**
 * Calculates the amount a recipient receives after the protocol fee is deducted.
 *
 * @param amount - Transfer amount in stroops.
 * @param feeBps - Fee rate in basis points. Must be an integer in `[0, 10000]`.
 * @returns Net receive amount in stroops.
 * @throws {ValidationError} If `feeBps` is not an integer, or is outside `[0, 10000]`.
 */
export function calculateReceiveAmount(amount: bigint, feeBps: number): bigint {
  // #665: Calculate receive amount as total - fee
  const fee = calculateFee(amount, feeBps);
  return amount - fee;
}

/**
 * Formats a raw stroop integer string as a human-readable decimal amount.
 * Stellar uses 7 decimal places (1 XLM = 10,000,000 stroops).
 *
 * @example
 * formatStellarAmount('10000000') // '1.0000000'
 * formatStellarAmount('500')      // '0.0000500'
 */
export function formatStellarAmount(amount: string): string {
  // #666: Format stroops to XLM (7 decimal places) using BigInt
  const bn = BigInt(amount);
  const divisor = BigInt(10000000); // 10^7

  // Get integer and fractional parts
  const integer = bn / divisor;
  const remainder = bn % divisor;

  // Format fractional part with leading zeros
  const fractionalStr = remainder.toString().padStart(7, '0');

  return `${integer}.${fractionalStr}`;
}

/**
 * Generates a stable UUIDv4-like idempotency key using crypto.getRandomValues().
 * Used to prevent duplicate side-effects when retrying non-idempotent requests.
 *
 * @returns A 32-character hex string suitable for the Idempotency-Key header.
 */
export function generateIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Re-export token formatting utilities for convenience
export {
  formatTokenAmount,
  parseTokenAmount,
  isSacTokenAddress,
  validateSacTokenAddress,
  isValidTokenIdentifier,
  tokenToSourceAsset,
  tokenFromLegacy,
  getDefaultDecimals,
  isNativeToken,
  isSacToken,
} from './token';
