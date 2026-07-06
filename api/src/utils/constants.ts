/**
 * Shared validation constants for the API.
 */

/** Matches any Stellar public address: account (`G...`) or contract (`C...`). */
export const STELLAR_ADDRESS_REGEX = /^[GC][A-Z2-7]{55}$/;

/** Matches only Soroban contract addresses (`C...`). */
export const C_ADDRESS_REGEX = /^C[A-Z2-7]{55}$/;
