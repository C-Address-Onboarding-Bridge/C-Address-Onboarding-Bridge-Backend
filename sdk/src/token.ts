import { Token, TokenMetadata } from './types';
import { ValidationError } from './errors';

// ─── StrKey (C-address) validation ────────────────────────────────────────────
//
// The SDK is shipped as a browser bundle with a tight size budget, so it cannot
// depend on `@stellar/stellar-sdk` (or `stellar-base`) just to validate a
// contract address. StrKey contract addresses are small enough to decode here:
// `base32(version_byte || 32-byte payload || 2-byte CRC16-XModem checksum)`.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CONTRACT_ADDRESS_LENGTH = 56;
const CONTRACT_VERSION_BYTE = 16; // 2 << 3, the StrKey version byte for contracts
const CONTRACT_DECODED_LENGTH = 35; // version + 32-byte payload + 2-byte checksum

/** Decodes RFC 4648 base32 (no padding); returns `null` for invalid input. */
function base32Decode(input: string): Uint8Array | null {
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];

  for (const char of input) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;

    buffer = ((buffer << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }

  // Any leftover bits must be zero padding for a canonical encoding.
  if (bits >= 5 || (buffer & ((1 << bits) - 1)) !== 0) return null;

  return Uint8Array.from(bytes);
}

/** CRC16-XModem as used by Stellar StrKey checksums. */
function crc16Xmodem(data: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

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

/**
 * Returns `true` if the string is a valid SAC token contract address
 * (C-address), including its StrKey checksum.
 */
export function isSacTokenAddress(address: string): boolean {
  if (address.length !== CONTRACT_ADDRESS_LENGTH) return false;
  if (!/^C[A-Z2-7]{55}$/.test(address)) return false;

  const decoded = base32Decode(address);
  if (decoded === null || decoded.length !== CONTRACT_DECODED_LENGTH) return false;
  if (decoded[0] !== CONTRACT_VERSION_BYTE) return false;

  const expectedChecksum = decoded[33] | (decoded[34] << 8);
  return crc16Xmodem(decoded.subarray(0, 33)) === expectedChecksum;
}

/** Validates a SAC token address and throws a typed error if invalid. */
export function validateSacTokenAddress(address: string): void {
  if (!isSacTokenAddress(address)) {
    throw new ValidationError('Invalid SAC token address', {
      fields: { contractId: `Must be a valid contract address (C-address), got: ${address}` },
    });
  }
}

/** Returns `true` if the string is a valid token identifier (either `"native"` or a C-address). */
export function isValidTokenIdentifier(identifier: string): boolean {
  return identifier === 'native' || isSacTokenAddress(identifier);
}

// ─── Token Serialization ────────────────────────────────────────────────────

/** Serializes a Token into the format expected by the bridge API. */
export function tokenToSourceAsset(token: Token): string {
  if (isNativeToken(token)) {
    return 'native';
  }
  if (isSacToken(token)) {
    return token.contractId;
  }
  throw new Error(`Unknown token type: ${(token as any).type}`);
}

/** Derives a Token from legacy string parameters. Defaults to native XLM. */
export function tokenFromLegacy(tokenAddress?: string, sourceAsset?: string): Token {
  // Use tokenAddress if provided and valid, fall back to sourceAsset, then native
  const identifier = tokenAddress || sourceAsset;

  if (!identifier || identifier === 'native') {
    return { type: 'native' };
  }

  // Validate and return as SAC token
  validateSacTokenAddress(identifier);
  return { type: 'sac', contractId: identifier };
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
  // Handle zero case
  if (amount === '0') return '0';

  const padded = amount.padStart(decimals + 1, '0');
  const integerPart = padded.slice(0, -decimals) || '0';
  const fractionalPart = padded.slice(-decimals);

  return `${integerPart}.${fractionalPart}`;
}

/**
 * Parses a human-readable decimal amount into the token's smallest unit.
 *
 * @param amount - Human-readable amount (e.g. `"1.5"`).
 * @param decimals - Number of decimal places the token uses.
 * @returns Raw integer amount as a string (e.g. `"1500000"` for 6 decimals).
 */
export function parseTokenAmount(amount: string, decimals: number): string {
  const parts = amount.split('.');
  const integerPart = parts[0] || '0';
  const fractionalPart = (parts[1] || '').padEnd(decimals, '0').slice(0, decimals);

  return (integerPart + fractionalPart).replace(/^0+(?=.)/, '');
}

/**
 * Returns the default decimal places for a given token.
 * Native XLM uses 7 decimals (stroops). SAC tokens default to 6 (common for USDC-like assets)
 * but should be queried via `getTokenMetadata` for accuracy.
 */
export function getDefaultDecimals(token: Token): number {
  if (isNativeToken(token)) {
    return 7; // XLM stroops
  }
  // SAC tokens default to 6 (USDC-like)
  return 6;
}