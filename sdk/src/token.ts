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
  throw new Error('Not implemented: formatTokenAmount');
}

/**
 * Parses a human-readable decimal amount into the token's smallest unit.
 *
 * @param amount - Human-readable amount (e.g. `"1.5"`).
 * @param decimals - Number of decimal places the token uses.
 * @returns Raw integer amount as a string (e.g. `"1500000"` for 6 decimals).
 */
export function parseTokenAmount(amount: string, decimals: number): string {
  throw new Error('Not implemented: parseTokenAmount');
}

/**
 * Returns the default decimal places for a given token.
 * Native XLM uses 7 decimals (stroops). SAC tokens default to 6 (common for USDC-like assets)
 * but should be queried via `getTokenMetadata` for accuracy.
 */
export function getDefaultDecimals(token: Token): number {
  throw new Error('Not implemented: getDefaultDecimals');
}