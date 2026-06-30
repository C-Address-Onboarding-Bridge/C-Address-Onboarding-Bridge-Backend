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
  return /^C[A-Z2-7]{55}$/.test(address);
}

/** Validates a SAC token address and throws a typed error if invalid. */
export function validateSacTokenAddress(address: string): void {
  if (!isSacTokenAddress(address)) {
    throw new ValidationError(`Invalid SAC token address: "${address}". Expected a 56-character C-address.`);
  }
}

/** Returns `true` if the string is a valid token identifier (either `"native"` or a C-address). */
export function isValidTokenIdentifier(identifier: string): boolean {
  return identifier === 'native' || isSacTokenAddress(identifier);
}

// ─── Token Serialization ────────────────────────────────────────────────────

/** Serializes a Token into the format expected by the bridge API. */
export function tokenToSourceAsset(token: Token): string {
  if (isNativeToken(token)) return 'XLM';
  validateSacTokenAddress(token.contractId);
  return token.contractId;
}

/** Derives a Token from legacy string parameters. Defaults to native XLM. */
export function tokenFromLegacy(tokenAddress?: string, sourceAsset?: string): Token {
  if (tokenAddress && isSacTokenAddress(tokenAddress)) {
    return { type: 'sac', contractId: tokenAddress };
  }
  if (sourceAsset && sourceAsset !== 'XLM') {
    // Assume non-XLM sourceAsset is a contract ID for SAC tokens
    if (isSacTokenAddress(sourceAsset)) {
      return { type: 'sac', contractId: sourceAsset };
    }
  }
  return { type: 'native' };
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
  if (decimals < 0) throw new ValidationError('decimals must be non-negative');
  if (decimals === 0) return amount.replace(/^0+/, '') || '0';
  const padded = amount.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, -decimals) || '0';
  const fracPart = padded.slice(-decimals);
  return `${intPart}.${fracPart}`;
}

/**
 * Parses a human-readable decimal amount into the token's smallest unit.
 *
 * @param amount - Human-readable amount (e.g. `"1.5"`).
 * @param decimals - Number of decimal places the token uses.
 * @returns Raw integer amount as a string (e.g. `"1500000"` for 6 decimals).
 */
export function parseTokenAmount(amount: string, decimals: number): string {
  if (decimals < 0) throw new ValidationError('decimals must be non-negative');
  const [intPart = '0', fracPart = ''] = amount.split('.');
  const sanitizedFrac = fracPart.padEnd(decimals, '0').slice(0, decimals);
  const raw = intPart + sanitizedFrac;
  // Strip leading zeros, but keep at least one digit
  return raw.replace(/^0+/, '') || '0';
}

/**
 * Returns the default decimal places for a given token.
 * Native XLM uses 7 decimals (stroops). SAC tokens default to 6 (common for USDC-like assets)
 * but should be queried via `getTokenMetadata` for accuracy.
 */
export function getDefaultDecimals(token: Token): number {
  return isNativeToken(token) ? 7 : 6;
}