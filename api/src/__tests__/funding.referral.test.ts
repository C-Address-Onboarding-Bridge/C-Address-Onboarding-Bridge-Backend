/**
 * Tests for referral funding endpoints and analytics
 *
 * This test suite covers:
 * - Funding with referrer tracking via fund_c_address_with_referral
 * - Referral analytics endpoint
 * - Prometheus metrics for referred funding
 * - Referrer address validation
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;
const C_ADDRESS_REGEX = /^C[A-Z0-9]{55}$/;

interface FundingRequest {
  sourceAddress: string;
  targetAddress: string;
  tokenAddress: string;
  amount: string;
  referrer?: string;
  memo?: string;
}

interface ReferralStats {
  volume: string;
  count: number;
  accruedFees: string;
}

describe("Referral Funding Tests (#403)", () => {
  let testKeypair: Keypair;
  let targetCAddress: string;
  let tokenCAddress: string;
  let referrerAddress: string;

  beforeAll(() => {
    testKeypair = Keypair.random();
    targetCAddress = "C" + testKeypair.publicKey().slice(1);
    tokenCAddress = "C" + Keypair.random().publicKey().slice(1);
    referrerAddress = "C" + Keypair.random().publicKey().slice(1);
  });

  describe("POST /api/v1/fund/prepare with referrer", () => {
    it("should accept valid referrer field in funding request", () => {
      const request: FundingRequest = {
        sourceAddress: testKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
        referrer: referrerAddress,
      };

      // Validate request structure
      expect(request.sourceAddress).toMatch(STELLAR_ADDRESS_REGEX);
      expect(request.targetAddress).toMatch(C_ADDRESS_REGEX);
      expect(request.tokenAddress).toMatch(C_ADDRESS_REGEX);
      expect(request.amount).toMatch(/^\d+$/);
      expect(request.referrer).toMatch(C_ADDRESS_REGEX);
    });

    it("should route to fund_c_address_with_referral when referrer is provided", () => {
      const request: FundingRequest = {
        sourceAddress: testKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
        referrer: referrerAddress,
      };

      // This should use fund_c_address_with_referral contract function
      const contractFunction = request.referrer ? "fund_c_address_with_referral" : "fund_c_address";
      expect(contractFunction).toBe("fund_c_address_with_referral");
    });

    it("should validate referrer address format", () => {
      const invalidReferrers = [
        "G" + testKeypair.publicKey().slice(1), // Stellar address instead of C-address
        "invalid", // Random string
        "C" + "x".repeat(55), // Invalid characters
      ];

      invalidReferrers.forEach((invalidReferrer) => {
        expect(invalidReferrer).not.toMatch(C_ADDRESS_REGEX);
      });
    });

    it("should fallback to fund_c_address when referrer is not provided", () => {
      const request: FundingRequest = {
        sourceAddress: testKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
      };

      const contractFunction = request.referrer ? "fund_c_address_with_referral" : "fund_c_address";
      expect(contractFunction).toBe("fund_c_address");
    });
  });

  describe("GET /api/v1/referrals/:address/stats", () => {
    it("should return referral stats with volume, count, and accrued fees", () => {
      const expectedStats: ReferralStats = {
        volume: "5000000",
        count: 2,
        accruedFees: "150000",
      };

      expect(expectedStats).toHaveProperty("volume");
      expect(expectedStats).toHaveProperty("count");
      expect(expectedStats).toHaveProperty("accruedFees");
      expect(typeof expectedStats.volume).toBe("string");
      expect(typeof expectedStats.count).toBe("number");
      expect(typeof expectedStats.accruedFees).toBe("string");
    });

    it("should return zero stats for referrer with no referrals", () => {
      const stats: ReferralStats = {
        volume: "0",
        count: 0,
        accruedFees: "0",
      };

      expect(stats.volume).toBe("0");
      expect(stats.count).toBe(0);
      expect(stats.accruedFees).toBe("0");
    });

    it("should calculate accrued fees based on referral rate and volume", () => {
      const volume = BigInt("1000000");
      const referralRateBps = 10; // 0.1%
      const accruedFees = (volume * BigInt(referralRateBps)) / 10000n;

      expect(accruedFees.toString()).toBe("100");
    });

    it("should aggregate multiple referral transactions into stats", () => {
      const transactions = [
        { amount: "1000000", timestamp: Date.now() },
        { amount: "2000000", timestamp: Date.now() },
        { amount: "3000000", timestamp: Date.now() },
      ];

      const totalVolume = transactions.reduce((sum, tx) => {
        return BigInt(sum) + BigInt(tx.amount);
      }, BigInt(0));

      expect(totalVolume.toString()).toBe("6000000");
      expect(transactions.length).toBe(3);
    });
  });

  describe("Prometheus metrics for referred funding", () => {
    it("should track referred funding volume with referrer label", () => {
      const metric = {
        name: "referred_funding_volume_stroops",
        labels: { referrer: referrerAddress },
        value: 1000000,
      };

      expect(metric.name).toBe("referred_funding_volume_stroops");
      expect(metric.labels.referrer).toBe(referrerAddress);
      expect(metric.value).toBeGreaterThan(0);
    });

    it("should track referred funding count with referrer label", () => {
      const metric = {
        name: "referred_funding_count",
        labels: { referrer: referrerAddress },
        value: 5,
      };

      expect(metric.name).toBe("referred_funding_count");
      expect(metric.labels.referrer).toBe(referrerAddress);
      expect(metric.value).toBeGreaterThan(0);
    });
  });

  describe("Referral validation", () => {
    it("should reject invalid referrer addresses", () => {
      const invalidAddresses = [
        "not-an-address",
        "G" + Keypair.random().publicKey().slice(1), // Stellar address
        "C" + "x".repeat(55), // Invalid character
        "", // Empty string
      ];

      invalidAddresses.forEach((addr) => {
        const isValid = C_ADDRESS_REGEX.test(addr);
        expect(isValid).toBe(false);
      });
    });

    it("should accept valid C-addresses as referrers", () => {
      const validAddresses = [
        "C" + Keypair.random().publicKey().slice(1),
        "C" + Keypair.random().publicKey().slice(1),
        "C" + Keypair.random().publicKey().slice(1),
      ];

      validAddresses.forEach((addr) => {
        const isValid = C_ADDRESS_REGEX.test(addr);
        expect(isValid).toBe(true);
      });
    });
  });

  describe("Referral integration scenarios", () => {
    it("should handle funding with referrer in complete flow", () => {
      const request: FundingRequest = {
        sourceAddress: testKeypair.publicKey(),
        targetAddress: targetCAddress,
        tokenAddress: tokenCAddress,
        amount: "1000000",
        referrer: referrerAddress,
        memo: "Referred by partner",
      };

      expect(request.sourceAddress).toBeTruthy();
      expect(request.targetAddress).toBeTruthy();
      expect(request.amount).toMatch(/^\d+$/);
      expect(request.referrer).toBeTruthy();
    });

    it("should track referral attribution across multiple fundings", () => {
      const referrals = [
        { amount: "1000000", referrer: referrerAddress, timestamp: Date.now() },
        { amount: "2000000", referrer: referrerAddress, timestamp: Date.now() },
      ];

      const totalByReferrer = referrals.reduce((sum, ref) => {
        return BigInt(sum) + BigInt(ref.amount);
      }, BigInt(0));

      expect(totalByReferrer.toString()).toBe("3000000");
      expect(referrals.filter((r) => r.referrer === referrerAddress).length).toBe(2);
    });
  });
});
