import { ValidationError } from './errors';

/**
 * Returns `true` if the string is a valid Stellar address (G-address or C-address).
 * Note: this accepts both account addresses (G…) and contract addresses (C…).
 * Use `isGAddress` / `isCAddress` when you need to distinguish between them.
 */
export function isValidStellarAddress(address: string): boolean {
  return /^[GC][A-Z2-7]{55}$/.test(address);
}

/** Returns `true` if the address is a Soroban contract address (starts with `C`). */
export function isCAddress(address: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(address);
}

/** Returns `true` if the address is a classic Stellar account address (starts with `G`). */
export function isGAddress(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address);
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
  return amount - calculateFee(amount, feeBps);
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
  const padded = amount.padStart(8, '0');
  const intPart = padded.slice(0, -7) || '0';
  const fracPart = padded.slice(-7);
  return `${intPart}.${fracPart}`;
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
