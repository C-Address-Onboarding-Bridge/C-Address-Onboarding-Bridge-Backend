import { Token, TokenMetadata } from './types';
import { ValidationError } from './errors';

// ─── Token Type Guards ────────────────────────────────────────────────────────

/** Returns `true` if the token is the native XLM asset. */
export function isNativeToken(token: Token): token is { type: 'native' } {
  return token.type === 'native';
}

/** Returns `true` if the token is a SAC (Stellar Asset Converter) token. */
export function isSacToken(token: Token): token is { type: 'sac'; contractId: string } {
  return token.type === 'sac';
}

// ─── Address Validation ───────────────────────────────────────────────────────

/** Returns `true` if the string is a valid SAC token contract address (C-address). */
export function isSacTokenAddress(address: string): boolean {
  throw new Error('Not implemented: isSacTokenAddress');
}

/** Validates a SAC token address and throws a typed error if invalid. */
export function validateSacTokenAddress(address: string): void {
  throw new Error('Not implemented: validateSacTokenAddress');
}

/** Returns `true` if the string is a valid token identifier (either `"native"` or a C-address). */
export function isValidTokenIdentifier(identifier: string): boolean {
  throw new Error('Not implemented: isValidTokenIdentifier');
}

// ─── Token Serialization ────────────────────────────────────────────────────

/** Serializes a Token into the format expected by the bridge API. */
export function tokenToSourceAsset(token: Token): string {
  throw new Error('Not implemented: tokenToSourceAsset');
}

/** Derives a Token from legacy string parameters. Defaults to native XLM. */
export function tokenFromLegacy(tokenAddress?: string, sourceAsset?: string): Token {
  throw new Error('Not implemented: tokenFromLegacy');
}

// ─── Amount Formatting / Parsing ──────────────────────────────────────────────

/**
 * Formats a raw integer amount (in the token's smallest unit) as a human-readable decimal string.
 *
 * @param amount - Raw integer amount as a string (e.g. `"1000000"`).
 * @param decimals - Number of decimal places the token uses (e.g. `6` for USDC).
 * @returns Human-readable amount (e.g. `"1.000000"`).
 */
export function formatTokenAmount(amount: string, decimals: number): string {
  // #663: Convert raw amount to human-readable decimal string using BigInt
  const bn = BigInt(amount);
  const divisor = BigInt(10) ** BigInt(decimals);

  // Get integer and fractional parts
  const integer = bn / divisor;
  const remainder = bn % divisor;

  // Format fractional part with leading zeros
  const fractionalStr = remainder.toString().padStart(decimals, '0');

  // Combine with decimal point
  if (decimals === 0) {
    return integer.toString();
  }
  return `${integer}.${fractionalStr}`;
}

/**
 * Parses a human-readable decimal amount into the token's smallest unit.
 *
 * @param amount - Human-readable amount (e.g. `"1.5"`).
 * @param decimals - Number of decimal places the token uses.
 * @returns Raw integer amount as a string (e.g. `"1500000"` for 6 decimals).
 */
export function parseTokenAmount(amount: string, decimals: number): string {
  // #663: Parse decimal string to raw amount using BigInt
  const parts = amount.split('.');
  const integerPart = parts[0] || '0';
  const fractionalPart = parts[1] || '';

  // Validate fractional digits don't exceed decimals
  if (fractionalPart.length > decimals) {
    throw new Error(`Too many decimal places: expected at most ${decimals}, got ${fractionalPart.length}`);
  }

  // Pad fractional part to the right with zeros
  const paddedFractional = fractionalPart.padEnd(decimals, '0');

  // Combine integer and fractional parts
  const rawAmount = BigInt(integerPart) * (BigInt(10) ** BigInt(decimals)) + BigInt(paddedFractional);

  return rawAmount.toString();
}

/**
 * Returns the default decimal places for a given token.
 * Native XLM uses 7 decimals (stroops). SAC tokens default to 6 (common for USDC-like assets)
 * but should be queried via `getTokenMetadata` for accuracy.
 */
export function getDefaultDecimals(token: Token): number {
  // #664: Return default decimals based on token type
  if (isNativeToken(token)) {
    return 7; // XLM uses 7 decimals (stroops)
  }
  return 6; // SAC tokens default to 6 decimals
}