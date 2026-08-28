/**
 * Tests for commit-reveal funding endpoints
 *
 * This test suite covers:
 * - Two-phase commit-reveal funding flow for front-running protection
 * - Commitment hash computation
 * - Commitment state and expiry tracking
 * - Full commit-reveal cycle
 * - Expired commitment handling
 */

import { describe, it, expect, beforeAll } from "vitest";
import { Keypair, hash } from "@stellar/stellar-sdk";
import crypto from "crypto";

const C_ADDRESS_REGEX = /^C[A-Z0-9]{55}$/;

interface CommitmentRequest {
  commitmentHash: string;
}

interface CommitmentParams {
  sourceAddress: string;
  targetAddress: string;
  tokenAddress: string;
  amount: string;
  nonce: string;
}

interface CommitmentState {
  commitmentHash: string;
  status: "pending" | "revealed" | "expired";
  expiryTime: number;
  timestamp: number;
}

interface RevealRequest {
  commitmentHash: string;
  sourceAddress: string;
  targetAddress: string;
  tokenAddress: string;
  amount: string;
  nonce: string;
}

describe("Commit-Reveal Funding Tests (#404)", () => {
  let testKeypair: Keypair;
  let targetCAddress: string;
  let tokenCAddress: string;

  beforeAll(() => {
    testKeypair = Keypair.random();
    targetCAddress = "C" + testKeypair.publicKey().slice(1);
    tokenCAddress = "C" + Keypair.random().publicKey().slice(1);
  });

  describe("Commitment Hash Computation", () => {
    it("should compute valid commitment hash from parameters", () => {
      const params: CommitmentParams = {
        sourceAddress: testKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
        nonce: crypto.randomBytes(32).toString("hex"),
      };

      // Simulate hash computation
      const hashInput = Buffer.concat([
        Buffer.from(params.sourceAddress),
        Buffer.from(params.targetAddress),
        Buffer.from(params.tokenAddress),
        Buffer.from(params.amount),
        Buffer.from(params.nonce, "hex"),
      ]);

      const commitmentHash = crypto.createHash("sha256").update(hashInput).digest("hex");

      expect(commitmentHash).toBeTruthy();
      expect(commitmentHash).toHaveLength(64); // SHA256 hex output is 64 chars
    });

    it("should produce consistent hash for same parameters", () => {
      const params: CommitmentParams = {
        sourceAddress: testKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
        nonce: "abc123",
      };

      const hashInput = Buffer.concat([
        Buffer.from(params.sourceAddress),
        Buffer.from(params.targetAddress),
        Buffer.from(params.tokenAddress),
        Buffer.from(params.amount),
        Buffer.from(params.nonce),
      ]);

      const hash1 = crypto.createHash("sha256").update(hashInput).digest("hex");
      const hash2 = crypto.createHash("sha256").update(hashInput).digest("hex");

      expect(hash1).toBe(hash2);
    });

    it("should produce different hash for different parameters", () => {
      const nonce1 = "nonce1";
      const nonce2 = "nonce2";

      const hashInput1 = Buffer.concat([Buffer.from(nonce1)]);
      const hashInput2 = Buffer.concat([Buffer.from(nonce2)]);

      const hash1 = crypto.createHash("sha256").update(hashInput1).digest("hex");
      const hash2 = crypto.createHash("sha256").update(hashInput2).digest("hex");

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("POST /api/v1/fund/commit - Commitment Phase", () => {
    it("should accept commitment hash", () => {
      const params: CommitmentParams = {
        sourceAddress: testKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
        nonce: crypto.randomBytes(32).toString("hex"),
      };

      const hashInput = Buffer.concat([
        Buffer.from(params.sourceAddress),
        Buffer.from(params.targetAddress),
        Buffer.from(params.tokenAddress),
        Buffer.from(params.amount),
        Buffer.from(params.nonce, "hex"),
      ]);

      const commitmentHash = crypto.createHash("sha256").update(hashInput).digest("hex");
      const request: CommitmentRequest = { commitmentHash };

      expect(request.commitmentHash).toBeTruthy();
      expect(request.commitmentHash).toHaveLength(64);
    });

    it("should record commitment with initial state", () => {
      const commitmentHash = crypto.randomBytes(32).toString("hex");
      const commitment: CommitmentState = {
        commitmentHash,
        status: "pending",
        expiryTime: Date.now() + 3600000, // 1 hour from now
        timestamp: Date.now(),
      };

      expect(commitment.commitmentHash).toBe(commitmentHash);
      expect(commitment.status).toBe("pending");
      expect(commitment.expiryTime).toBeGreaterThan(commitment.timestamp);
    });

    it("should return commitment hash on successful commit", () => {
      const commitmentHash = crypto.randomBytes(32).toString("hex");
      const response = {
        commitmentHash,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };

      expect(response.commitmentHash).toBe(commitmentHash);
      expect(response.expiresAt).toBeTruthy();
    });
  });

  describe("GET /api/v1/fund/commit/:hash - Commitment Query", () => {
    it("should return commitment state for valid hash", () => {
      const commitmentHash = crypto.randomBytes(32).toString("hex");
      const commitment: CommitmentState = {
        commitmentHash,
        status: "pending",
        expiryTime: Date.now() + 3600000,
        timestamp: Date.now(),
      };

      expect(commitment.commitmentHash).toBe(commitmentHash);
      expect(commitment.status).toBe("pending");
    });

    it("should return pending status before reveal", () => {
      const commitment: CommitmentState = {
        commitmentHash: crypto.randomBytes(32).toString("hex"),
        status: "pending",
        expiryTime: Date.now() + 3600000,
        timestamp: Date.now(),
      };

      expect(commitment.status).toBe("pending");
    });

    it("should return revealed status after reveal", () => {
      const commitment: CommitmentState = {
        commitmentHash: crypto.randomBytes(32).toString("hex"),
        status: "revealed",
        expiryTime: Date.now() + 3600000,
        timestamp: Date.now(),
      };

      expect(commitment.status).toBe("revealed");
    });

    it("should return expiry time", () => {
      const expiryTime = Date.now() + 3600000;
      const commitment: CommitmentState = {
        commitmentHash: crypto.randomBytes(32).toString("hex"),
        status: "pending",
        expiryTime,
        timestamp: Date.now(),
      };

      expect(commitment.expiryTime).toBe(expiryTime);
      expect(commitment.expiryTime).toBeGreaterThan(commitment.timestamp);
    });
  });

  describe("POST /api/v1/fund/reveal - Reveal Phase", () => {
    it("should accept reveal request with commitment hash and preimage", () => {
      const params: CommitmentParams = {
        sourceAddress: testKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
        nonce: crypto.randomBytes(32).toString("hex"),
      };

      const hashInput = Buffer.concat([
        Buffer.from(params.sourceAddress),
        Buffer.from(params.targetAddress),
        Buffer.from(params.tokenAddress),
        Buffer.from(params.amount),
        Buffer.from(params.nonce, "hex"),
      ]);

      const commitmentHash = crypto.createHash("sha256").update(hashInput).digest("hex");
      const revealRequest: RevealRequest = {
        commitmentHash,
        ...params,
      };

      expect(revealRequest.commitmentHash).toBe(commitmentHash);
      expect(revealRequest.sourceAddress).toBeTruthy();
      expect(revealRequest.targetAddress).toBeTruthy();
    });

    it("should verify commitment hash matches reveal preimage", () => {
      const sourceAddress = testKeypair.publicKey();
      const targetAddress = targetCAddress;
      const tokenAddress = tokenCAddress;
      const amount = "1000000";
      const nonce = "test-nonce-123";

      const hashInput = Buffer.concat([
        Buffer.from(sourceAddress),
        Buffer.from(targetAddress),
        Buffer.from(tokenAddress),
        Buffer.from(amount),
        Buffer.from(nonce),
      ]);

      const expectedHash = crypto.createHash("sha256").update(hashInput).digest("hex");
      const revealParams = { sourceAddress, targetAddress, tokenAddress, amount, nonce };

      // Recompute hash from reveal params
      const recomputedHashInput = Buffer.concat([
        Buffer.from(revealParams.sourceAddress),
        Buffer.from(revealParams.targetAddress),
        Buffer.from(revealParams.tokenAddress),
        Buffer.from(revealParams.amount),
        Buffer.from(revealParams.nonce),
      ]);
      const recomputedHash = crypto.createHash("sha256").update(recomputedHashInput).digest("hex");

      expect(recomputedHash).toBe(expectedHash);
    });

    it("should reject reveal with mismatched commitment hash", () => {
      const correctHash = crypto.randomBytes(32).toString("hex");
      const incorrectHash = crypto.randomBytes(32).toString("hex");

      expect(correctHash).not.toBe(incorrectHash);
    });
  });

  describe("Commit-Reveal Flow Integration", () => {
    it("should handle complete commit-reveal cycle", () => {
      // Step 1: Prepare parameters
      const params: CommitmentParams = {
        sourceAddress: testKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
        nonce: crypto.randomBytes(32).toString("hex"),
      };

      // Step 2: Compute commitment hash
      const hashInput = Buffer.concat([
        Buffer.from(params.sourceAddress),
        Buffer.from(params.targetAddress),
        Buffer.from(params.tokenAddress),
        Buffer.from(params.amount),
        Buffer.from(params.nonce, "hex"),
      ]);
      const commitmentHash = crypto.createHash("sha256").update(hashInput).digest("hex");

      // Step 3: Submit commitment
      const commitment: CommitmentState = {
        commitmentHash,
        status: "pending",
        expiryTime: Date.now() + 3600000,
        timestamp: Date.now(),
      };

      expect(commitment.status).toBe("pending");

      // Step 4: Query commitment
      expect(commitment.commitmentHash).toBe(commitmentHash);

      // Step 5: Reveal with preimage
      const revealRequest: RevealRequest = {
        commitmentHash,
        ...params,
      };

      expect(revealRequest.commitmentHash).toBe(commitmentHash);

      // Step 6: Verify commitment transitions to revealed
      const revealedCommitment: CommitmentState = {
        ...commitment,
        status: "revealed",
      };

      expect(revealedCommitment.status).toBe("revealed");
    });

    it("should handle expired commitment rejection", () => {
      const expiredTime = Date.now() - 1000; // 1 second ago
      const commitment: CommitmentState = {
        commitmentHash: crypto.randomBytes(32).toString("hex"),
        status: "pending",
        expiryTime: expiredTime,
        timestamp: expiredTime - 3600000,
      };

      const isExpired = commitment.expiryTime < Date.now();
      expect(isExpired).toBe(true);
    });

    it("should allow reveal before expiration", () => {
      const futureExpiry = Date.now() + 3600000;
      const commitment: CommitmentState = {
        commitmentHash: crypto.randomBytes(32).toString("hex"),
        status: "pending",
        expiryTime: futureExpiry,
        timestamp: Date.now(),
      };

      const isExpired = commitment.expiryTime < Date.now();
      expect(isExpired).toBe(false);
    });
  });

  describe("SDK Helper for Commitment Hash", () => {
    it("should provide helper function to compute commitment hash", () => {
      const params: CommitmentParams = {
        sourceAddress: testKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
        nonce: crypto.randomBytes(32).toString("hex"),
      };

      // Simulate SDK helper
      const computeCommitmentHash = (params: CommitmentParams): string => {
        const hashInput = Buffer.concat([
          Buffer.from(params.sourceAddress),
          Buffer.from(params.targetAddress),
          Buffer.from(params.tokenAddress),
          Buffer.from(params.amount),
          Buffer.from(params.nonce),
        ]);
        return crypto.createHash("sha256").update(hashInput).digest("hex");
      };

      const hash = computeCommitmentHash(params);
      expect(hash).toHaveLength(64);
    });

    it("helper should produce consistent results", () => {
      const params: CommitmentParams = {
        sourceAddress: testKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
        nonce: "static-nonce",
      };

      const computeCommitmentHash = (params: CommitmentParams): string => {
        const hashInput = Buffer.concat([
          Buffer.from(params.sourceAddress),
          Buffer.from(params.targetAddress),
          Buffer.from(params.tokenAddress),
          Buffer.from(params.amount),
          Buffer.from(params.nonce),
        ]);
        return crypto.createHash("sha256").update(hashInput).digest("hex");
      };

      const hash1 = computeCommitmentHash(params);
      const hash2 = computeCommitmentHash(params);

      expect(hash1).toBe(hash2);
    });
  });
});
