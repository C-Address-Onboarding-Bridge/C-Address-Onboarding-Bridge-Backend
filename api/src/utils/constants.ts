/**
 * Shared validation constants for the API.
 */
import { StrKey } from '@stellar/stellar-sdk';

/** Matches any Stellar public address: account (`G...`) or contract (`C...`). */
export const STELLAR_ADDRESS_REGEX = /^[GC][A-Z2-7]{55}$/;

/** Matches only Soroban contract addresses (`C...`). */
export const C_ADDRESS_REGEX = /^C[A-Z2-7]{55}$/;

/**
 * Validates a Stellar address with proper checksum verification.
 * Accepts both account (G...) and contract (C...) addresses.
 * #656: Use StrKey for proper checksum validation instead of regex only.
 */
export function isValidStellarAddress(address: string): boolean {
  try {
    return (
      StrKey.isValidEd25519PublicKey(address) ||
      StrKey.isValidContract(address)
    );
  } catch {
    return false;
  }
}

/**
 * Validates a Stellar G-address (account only) with checksum verification.
 * Rejects C-addresses.
 * #658: Only accept classic Stellar account addresses for on-ramp wallets.
 */
export function isValidGAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

/**
 * Validates a Stellar C-address (contract only) with checksum verification.
 */
export function isValidCAddress(address: string): boolean {
  try {
    return StrKey.isValidContract(address);
  } catch {
    return false;
  }
}
