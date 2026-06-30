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
 * Calculates the protocol fee for a given amount and fee rate.
 *
 * @param amount - Transfer amount in stroops.
 * @param feeBps - Fee rate in basis points (e.g. `30` = 0.3%).
 * @returns Fee in stroops (truncated, not rounded).
 */
export function calculateFee(amount: bigint, feeBps: number): bigint {
  return (amount * BigInt(feeBps)) / BigInt(10000);
}

/**
 * Calculates the amount a recipient receives after the protocol fee is deducted.
 *
 * @param amount - Transfer amount in stroops.
 * @param feeBps - Fee rate in basis points.
 * @returns Net receive amount in stroops.
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
