import { Token, TokenMetadata } from './types';
import { ValidationError } from './errors';

// ─── StrKey Contract Address Validation ──────────────────────────────────────
// Local implementation of the StrKey contract-address check (base32 decode +
// CRC16-XModem checksum) so we don't pull the full Stellar SDK into bundles.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CONTRACT_VERSION_BYTE = 6 << 3; // 'C' prefix, version byte 0x30
const CONTRACT_PAYLOAD_LENGTH = 32;

function base32Decode(input: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (let i = 0; i < input.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(input[i]);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >>> bits) & 0xff);
    }
  }

  return new Uint8Array(output);
}

function crc16XModem(data: Uint8Array): number {
  let crc = 0x0000;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

function isValidContractStrKey(address: string): boolean {
  if (typeof address !== 'string' || address.length !== 56) return false;
  if (address[0] !== 'C') return false;

  const decoded = base32Decode(address);
  if (!decoded) return false;

  // version byte + 32-byte payload + 2-byte checksum
  if (decoded.length !== 1 + CONTRACT_PAYLOAD_LENGTH + 2) return false;
  if (decoded[0] !== CONTRACT_VERSION_BYTE) return false;

  const payload = decoded.subarray(0, decoded.length - 2);
  const checksum = (decoded[decoded.length - 2] << 8) | decoded[decoded.length - 1];

  return crc16XModem(payload) === checksum;
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

/** Returns `true` if the string is a valid SAC token contract address (C-address). */
export function isSacTokenAddress(address: string): boolean {
  return isValidContractStrKey(address);
}

/** Validates a SAC token address and throws a typed error if invalid. */
export function validateSacTokenAddress(address: string): void {
  if (!isSacTokenAddress(address)) {
    throw new ValidationError('Invalid SAC token address', {
      contractId: `Must be a valid contract address (C-address), got: ${address}`,
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