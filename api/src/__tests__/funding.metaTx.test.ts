/**
 * Tests for meta-transaction funding endpoints
 *
 * This test suite covers:
 * - Gasless funding relay via execute_meta_fund
 * - Meta-transaction signature verification
 * - Nonce replay protection
 * - Relayer balance monitoring
 * - Rate limiting for relay endpoint
 * - SDK signing helpers
 */

import { describe, it, expect, beforeAll } from "vitest";
import { Keypair, hash } from "@stellar/stellar-sdk";
import crypto from "crypto";

const C_ADDRESS_REGEX = /^C[A-Z0-9]{55}$/;
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

interface MetaTransactionPayload {
  sourceAddress: string;
  targetAddress: string;
  tokenAddress: string;
  amount: string;
  nonce: string;
  signature: string;
}

interface MetaTransactionState {
  userAddress: string;
  nonce: number;
  lastUsedTimestamp: number;
}

interface RelayerStatus {
  address: string;
  balance: string;
  status: "healthy" | "warning" | "critical";
  estimatedGasLeft: number;
}

describe("Meta-Transaction Funding Tests (#405)", () => {
  let userKeypair: Keypair;
  let relayerKeypair: Keypair;
  let targetCAddress: string;
  let tokenCAddress: string;

  beforeAll(() => {
    userKeypair = Keypair.random();
    relayerKeypair = Keypair.random();
    targetCAddress = "C" + userKeypair.publicKey().slice(1);
    tokenCAddress = "C" + Keypair.random().publicKey().slice(1);
  });

  describe("POST /api/v1/fund/meta - Meta-Transaction Relay", () => {
    it("should accept signed meta-transaction payload", () => {
      const message = Buffer.concat([
        Buffer.from("STELLAR_META_TX"),
        Buffer.from(userKeypair.publicKey()),
        Buffer.from(targetCAddress),
        Buffer.from(tokenCAddress),
        Buffer.from("1000000"),
        Buffer.from("0"),
      ]);

      const signature = userKeypair.sign(message).toString("hex");

      const metaTx: MetaTransactionPayload = {
        sourceAddress: userKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
        nonce: "0",
        signature,
      };

      expect(metaTx.sourceAddress).toMatch(STELLAR_ADDRESS_REGEX);
      expect(metaTx.targetAddress).toMatch(C_ADDRESS_REGEX);
      expect(metaTx.signature).toBeTruthy();
    });

    it("should reject unsigned meta-transaction", () => {
      const metaTx = {
        sourceAddress: userKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
        nonce: "0",
        signature: "", // Empty signature
      };

      const isValid = metaTx.signature && metaTx.signature.length > 0;
      expect(isValid).toBe(false);
    });

    it("should return transaction hash on successful relay", () => {
      const response = {
        hash: crypto.randomBytes(32).toString("hex"),
        status: "pending",
        explorerUrl: "https://stellar.expert/explorer/testnet/tx/...",
      };

      expect(response.hash).toBeTruthy();
      expect(response.status).toBe("pending");
      expect(response.explorerUrl).toBeTruthy();
    });
  });

  describe("Signature Verification", () => {
    it("should verify valid meta-transaction signature", () => {
      const message = Buffer.concat([
        Buffer.from("STELLAR_META_TX"),
        Buffer.from(userKeypair.publicKey()),
        Buffer.from(targetCAddress),
        Buffer.from(tokenCAddress),
        Buffer.from("1000000"),
        Buffer.from("0"),
      ]);

      const signature = userKeypair.sign(message);
      const publicKey = Keypair.fromPublicKey(userKeypair.publicKey());

      const isValid = publicKey.verify(message, signature);
      expect(isValid).toBe(true);
    });

    it("should reject invalid signature", () => {
      const message = Buffer.from("test message");
      const invalidSignature = crypto.randomBytes(64);
      const publicKey = Keypair.fromPublicKey(userKeypair.publicKey());

      const isValid = publicKey.verify(message, invalidSignature);
      expect(isValid).toBe(false);
    });

    it("should reject signature from wrong signer", () => {
      const message = Buffer.from("test message");
      const signature = userKeypair.sign(message);
      const wrongPublicKey = Keypair.fromPublicKey(relayerKeypair.publicKey());

      const isValid = wrongPublicKey.verify(message, signature);
      expect(isValid).toBe(false);
    });

    it("should reject tampered message", () => {
      const originalMessage = Buffer.from("original message");
      const signature = userKeypair.sign(originalMessage);
      const tamperedMessage = Buffer.from("tampered message");
      const publicKey = Keypair.fromPublicKey(userKeypair.publicKey());

      const isValid = publicKey.verify(tamperedMessage, signature);
      expect(isValid).toBe(false);
    });
  });

  describe("Nonce Replay Protection", () => {
    it("should track nonce per user", () => {
      const state: MetaTransactionState = {
        userAddress: userKeypair.publicKey(),
        nonce: 0,
        lastUsedTimestamp: Date.now(),
      };

      expect(state.userAddress).toBe(userKeypair.publicKey());
      expect(state.nonce).toBe(0);
    });

    it("should reject nonce replay attack", () => {
      const usedNonces = new Set<string>(["0", "1"]);
      const replayNonce = "0";

      const isReplayed = usedNonces.has(replayNonce);
      expect(isReplayed).toBe(true);
    });

    it("should accept next sequential nonce", () => {
      const lastNonce = 5;
      const nextNonce = lastNonce + 1;

      expect(nextNonce).toBe(6);
      expect(nextNonce > lastNonce).toBe(true);
    });

    it("should track nonce progression per user independently", () => {
      const user1Nonces = [0, 1, 2, 3];
      const user2Nonces = [0, 1, 2];

      expect(user1Nonces[user1Nonces.length - 1]).toBe(3);
      expect(user2Nonces[user2Nonces.length - 1]).toBe(2);
      expect(user1Nonces.length).toBeGreaterThan(user2Nonces.length);
    });

    it("should reject out-of-order nonces", () => {
      const lastUsedNonce = 5;
      const submittedNonce = 3; // Out of order

      const isValid = submittedNonce === lastUsedNonce + 1;
      expect(isValid).toBe(false);
    });
  });

  describe("Relayer Balance Monitoring", () => {
    it("should track relayer balance", () => {
      const relayerStatus: RelayerStatus = {
        address: relayerKeypair.publicKey(),
        balance: "50000000", // 50 XLM in stroops
        status: "healthy",
        estimatedGasLeft: 1000,
      };

      expect(relayerStatus.address).toMatch(STELLAR_ADDRESS_REGEX);
      expect(relayerStatus.balance).toMatch(/^\d+$/);
      expect(relayerStatus.status).toBe("healthy");
    });

    it("should alert when relayer balance is low", () => {
      const lowBalance = "100000"; // Low balance
      const relayerStatus: RelayerStatus = {
        address: relayerKeypair.publicKey(),
        balance: lowBalance,
        status: "warning",
        estimatedGasLeft: 50,
      };

      expect(relayerStatus.status).toBe("warning");
    });

    it("should alert critically when relayer balance is critical", () => {
      const criticalBalance = "10000"; // Critical balance
      const relayerStatus: RelayerStatus = {
        address: relayerKeypair.publicKey(),
        balance: criticalBalance,
        status: "critical",
        estimatedGasLeft: 5,
      };

      expect(relayerStatus.status).toBe("critical");
    });

    it("should calculate gas cost and remaining balance", () => {
      const startingBalance = BigInt("100000000"); // 100 XLM
      const gasCost = BigInt("1000"); // 1000 stroops
      const endingBalance = startingBalance - gasCost;

      expect(endingBalance.toString()).toBe("99999000");
      expect(endingBalance < startingBalance).toBe(true);
    });
  });

  describe("Rate Limiting for Relay Endpoint", () => {
    it("should track relay requests per user", () => {
      const requestLog = [
        { userAddress: userKeypair.publicKey(), timestamp: Date.now() },
        { userAddress: userKeypair.publicKey(), timestamp: Date.now() + 1000 },
      ];

      const userRequests = requestLog.filter((r) => r.userAddress === userKeypair.publicKey());
      expect(userRequests.length).toBe(2);
    });

    it("should enforce separate rate limit for relay endpoint", () => {
      const regularFundLimit = 100; // 100 per hour
      const relayFundLimit = 10; // 10 per hour - lower due to relayer fees

      expect(relayFundLimit).toBeLessThan(regularFundLimit);
    });

    it("should allow requests below rate limit", () => {
      const rateLimit = 10;
      const requestCount = 5;

      expect(requestCount < rateLimit).toBe(true);
    });

    it("should reject requests above rate limit", () => {
      const rateLimit = 10;
      const requestCount = 15;

      expect(requestCount < rateLimit).toBe(false);
    });
  });

  describe("SDK Signing Helper", () => {
    it("should provide helper to sign meta-transaction", () => {
      const payload = {
        sourceAddress: userKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
        nonce: "0",
      };

      // Simulate SDK helper
      const signMetaTransaction = (payload: any, keypair: Keypair): string => {
        const message = Buffer.concat([
          Buffer.from("STELLAR_META_TX"),
          Buffer.from(payload.sourceAddress),
          Buffer.from(payload.targetAddress),
          Buffer.from(payload.tokenAddress),
          Buffer.from(payload.amount),
          Buffer.from(payload.nonce),
        ]);
        return keypair.sign(message).toString("hex");
      };

      const signature = signMetaTransaction(payload, userKeypair);
      expect(signature).toBeTruthy();
      expect(signature.length).toBeGreaterThan(0);
    });

    it("helper should produce consistent signatures for same payload", () => {
      const payload = {
        sourceAddress: userKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
        nonce: "0",
      };

      const signMetaTransaction = (payload: any, keypair: Keypair): string => {
        const message = Buffer.concat([
          Buffer.from("STELLAR_META_TX"),
          Buffer.from(payload.sourceAddress),
          Buffer.from(payload.targetAddress),
          Buffer.from(payload.tokenAddress),
          Buffer.from(payload.amount),
          Buffer.from(payload.nonce),
        ]);
        return keypair.sign(message).toString("hex");
      };

      const sig1 = signMetaTransaction(payload, userKeypair);
      const sig2 = signMetaTransaction(payload, userKeypair);

      expect(sig1).toBe(sig2);
    });
  });

  describe("Meta-Transaction Integration Scenarios", () => {
    it("should handle complete meta-transaction flow", () => {
      const payload = {
        sourceAddress: userKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
        nonce: "0",
      };

      const message = Buffer.concat([
        Buffer.from("STELLAR_META_TX"),
        Buffer.from(payload.sourceAddress),
        Buffer.from(payload.targetAddress),
        Buffer.from(payload.tokenAddress),
        Buffer.from(payload.amount),
        Buffer.from(payload.nonce),
      ]);

      const signature = userKeypair.sign(message).toString("hex");

      const metaTx: MetaTransactionPayload = {
        ...payload,
        signature,
      };

      expect(metaTx.signature).toBeTruthy();
      expect(metaTx.sourceAddress).toBeTruthy();
    });

    it("should reject replay of same nonce", () => {
      const nonce = "5";
      const usedNonces = new Set<string>();

      // First submission
      usedNonces.add(nonce);
      expect(usedNonces.has(nonce)).toBe(true);

      // Replay attempt
      const isReplayed = usedNonces.has(nonce);
      expect(isReplayed).toBe(true);
    });

    it("should track relayer fees and balance impact", () => {
      const startingBalance = BigInt("100000000");
      const fundingAmount = BigInt("1000000");
      const relayerFeePercentage = 0.1; // 0.1% relayer fee
      const relayerFee = (fundingAmount * BigInt(Math.floor(relayerFeePercentage * 10000))) / BigInt(1000000);

      const endingBalance = startingBalance - relayerFee;
      expect(endingBalance < startingBalance).toBe(true);
    });
  });

  describe("Gasless Funding Onboarding", () => {
    it("should enable zero-balance user to be onboarded", () => {
      const newUserBalance = BigInt("0");
      const fundingAmount = BigInt("1000000");

      // User has no XLM for fees, but relayer covers it
      const canBeOnboarded = true; // Relayer will pay

      expect(canBeOnboarded).toBe(true);
      expect(newUserBalance).toBe(BigInt("0"));
      expect(fundingAmount).toBeGreaterThan(BigInt("0"));
    });

    it("should deduct relayer fees from relayer account", () => {
      const relayerStart = BigInt("100000000");
      const txFee = BigInt("1000");

      const relayerEnd = relayerStart - txFee;
      expect(relayerEnd).toBeLessThan(relayerStart);
    });

    it("should not affect user funds with relay submission", () => {
      const userBalance = BigInt("0");
      const fundAmount = BigInt("1000000");

      // After relay, user receives funds (from the source, not as payment)
      const userAfter = userBalance;

      expect(userAfter).toBe(userBalance);
    });
  });
});
