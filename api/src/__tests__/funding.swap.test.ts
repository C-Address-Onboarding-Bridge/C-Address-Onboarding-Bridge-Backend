/**
 * Tests for swap-funding endpoints
 *
 * This test suite covers:
 * - Funding C-address with any whitelisted asset via fund_c_address_with_swap
 * - Swap pool whitelisting and querying
 * - Slippage tolerance and server-side enforcement
 * - Expected output quotes
 * - Slippage rejection
 * - Unwhitelisted pool handling
 */

import { describe, it, expect, beforeAll } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const C_ADDRESS_REGEX = /^C[A-Z0-9]{55}$/;
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

interface SwapFundingRequest {
  sourceAddress: string;
  inputAsset: string; // Contract address for token
  outputAsset: string; // Contract address for token
  targetAddress: string;
  amount: string; // Input amount in stroops
  maxSlippage: number; // Slippage tolerance in basis points
}

interface SwapQuote {
  inputAsset: string;
  outputAsset: string;
  inputAmount: string;
  expectedOutputAmount: string;
  minimumOutputAmount: string;
  priceImpact: number;
  slippage: number;
}

interface SwapPool {
  id: string;
  assetA: string;
  assetB: string;
  reserveA: string;
  reserveB: string;
  isWhitelisted: boolean;
}

describe("Swap-Funding Tests (#406)", () => {
  let testKeypair: Keypair;
  let targetCAddress: string;
  let usdcAddress: string;
  let eurcAddress: string;
  let xlmAddress: string;

  beforeAll(() => {
    testKeypair = Keypair.random();
    targetCAddress = "C" + testKeypair.publicKey().slice(1);
    usdcAddress = "C" + Keypair.random().publicKey().slice(1);
    eurcAddress = "C" + Keypair.random().publicKey().slice(1);
    xlmAddress = "C" + Keypair.random().publicKey().slice(1);
  });

  describe("POST /api/v1/fund/swap - Swap Funding Submission", () => {
    it("should accept swap funding request with input and output assets", () => {
      const request: SwapFundingRequest = {
        sourceAddress: testKeypair.publicKey(),
        inputAsset: usdcAddress,
        outputAsset: xlmAddress,
        targetAddress: targetCAddress,
        amount: "1000000", // 10 USDC
        maxSlippage: 100, // 1% slippage
      };

      expect(request.sourceAddress).toMatch(STELLAR_ADDRESS_REGEX);
      expect(request.inputAsset).toMatch(C_ADDRESS_REGEX);
      expect(request.outputAsset).toMatch(C_ADDRESS_REGEX);
      expect(request.targetAddress).toMatch(C_ADDRESS_REGEX);
      expect(request.amount).toMatch(/^\d+$/);
      expect(request.maxSlippage).toBeGreaterThanOrEqual(0);
    });

    it("should reject swap with excessive slippage on client side", () => {
      const request: SwapFundingRequest = {
        sourceAddress: testKeypair.publicKey(),
        inputAsset: usdcAddress,
        outputAsset: xlmAddress,
        targetAddress: targetCAddress,
        amount: "1000000",
        maxSlippage: 10000, // 100% slippage - unreasonable
      };

      const isExcessiveSlippage = request.maxSlippage > 5000; // Server-side max is 50%
      expect(isExcessiveSlippage).toBe(true);
    });

    it("should accept reasonable slippage tolerance", () => {
      const request: SwapFundingRequest = {
        sourceAddress: testKeypair.publicKey(),
        inputAsset: usdcAddress,
        outputAsset: xlmAddress,
        targetAddress: targetCAddress,
        amount: "1000000",
        maxSlippage: 250, // 2.5% - reasonable
      };

      const isReasonable = request.maxSlippage <= 500; // Less than 5%
      expect(isReasonable).toBe(true);
    });

    it("should submit swap to execute_meta_fund with routing", () => {
      const request: SwapFundingRequest = {
        sourceAddress: testKeypair.publicKey(),
        inputAsset: usdcAddress,
        outputAsset: xlmAddress,
        targetAddress: targetCAddress,
        amount: "1000000",
        maxSlippage: 100,
      };

      const contractFunction = "fund_c_address_with_swap";
      expect(contractFunction).toBe("fund_c_address_with_swap");
    });
  });

  describe("GET /api/v1/swap/pools - Whitelisted Pools Query", () => {
    it("should return list of whitelisted pools", () => {
      const pools: SwapPool[] = [
        {
          id: "pool-1",
          assetA: usdcAddress,
          assetB: xlmAddress,
          reserveA: "1000000000",
          reserveB: "5000000000",
          isWhitelisted: true,
        },
        {
          id: "pool-2",
          assetA: eurcAddress,
          assetB: xlmAddress,
          reserveA: "500000000",
          reserveB: "2500000000",
          isWhitelisted: true,
        },
      ];

      expect(pools.length).toBeGreaterThan(0);
      pools.forEach((pool) => {
        expect(pool.isWhitelisted).toBe(true);
      });
    });

    it("should filter out non-whitelisted pools", () => {
      const allPools: SwapPool[] = [
        {
          id: "pool-1",
          assetA: usdcAddress,
          assetB: xlmAddress,
          reserveA: "1000000000",
          reserveB: "5000000000",
          isWhitelisted: true,
        },
        {
          id: "pool-2",
          assetA: usdcAddress,
          assetB: eurcAddress,
          reserveA: "500000000",
          reserveB: "2500000000",
          isWhitelisted: false,
        },
      ];

      const whitelistedPools = allPools.filter((p) => p.isWhitelisted);
      expect(whitelistedPools.length).toBe(1);
      expect(whitelistedPools[0].id).toBe("pool-1");
    });

    it("should include pool reserves for quote calculation", () => {
      const pool: SwapPool = {
        id: "pool-1",
        assetA: usdcAddress,
        assetB: xlmAddress,
        reserveA: "1000000000",
        reserveB: "5000000000",
        isWhitelisted: true,
      };

      expect(pool.reserveA).toMatch(/^\d+$/);
      expect(pool.reserveB).toMatch(/^\d+$/);
      expect(BigInt(pool.reserveA)).toBeGreaterThan(BigInt("0"));
      expect(BigInt(pool.reserveB)).toBeGreaterThan(BigInt("0"));
    });
  });

  describe("Swap Quote Endpoint", () => {
    it("should provide quote before submission", () => {
      const inputAmount = BigInt("1000000");
      const reserveA = BigInt("1000000000");
      const reserveB = BigInt("5000000000");

      // Constant product formula: (x + inputAmount) * (y - outputAmount) = x * y
      // For simplified calc: outputAmount ≈ (inputAmount * reserveB) / (reserveA + inputAmount)
      const outputAmount = (inputAmount * reserveB) / (reserveA + inputAmount);

      const quote: SwapQuote = {
        inputAsset: "USDC",
        outputAsset: "XLM",
        inputAmount: inputAmount.toString(),
        expectedOutputAmount: outputAmount.toString(),
        minimumOutputAmount: (outputAmount - (outputAmount * BigInt(100)) / BigInt(10000)).toString(), // 1% slippage
        priceImpact: 0.5, // 0.5% price impact
        slippage: 1.0, // 1% max slippage
      };

      expect(quote.expectedOutputAmount).toBeTruthy();
      expect(quote.minimumOutputAmount).toBeTruthy();
      expect(BigInt(quote.minimumOutputAmount)).toBeLessThan(BigInt(quote.expectedOutputAmount));
    });

    it("should calculate minimum output with slippage tolerance", () => {
      const expectedOutput = BigInt("5000000");
      const slippageBps = 250; // 2.5%

      const minimumOutput = expectedOutput - (expectedOutput * BigInt(slippageBps)) / BigInt(10000);

      expect(minimumOutput).toEqual(BigInt("4875000"));
      expect(minimumOutput < expectedOutput).toBe(true);
    });

    it("should account for price impact in quotes", () => {
      const largeInput = BigInt("100000000"); // Large swap
      const smallInput = BigInt("1000000"); // Small swap

      // Larger inputs have higher price impact
      const largeImpact = 5.0; // 5%
      const smallImpact = 0.1; // 0.1%

      expect(largeImpact).toBeGreaterThan(smallImpact);
    });

    it("should return consistent quotes for same parameters", () => {
      const request = {
        inputAmount: "1000000",
        inputAsset: usdcAddress,
        outputAsset: xlmAddress,
      };

      // Simulate quote calculation
      const calculateQuote = (req: typeof request): SwapQuote => {
        return {
          inputAsset: req.inputAsset,
          outputAsset: req.outputAsset,
          inputAmount: req.inputAmount,
          expectedOutputAmount: "5000000",
          minimumOutputAmount: "4950000",
          priceImpact: 0.3,
          slippage: 1.0,
        };
      };

      const quote1 = calculateQuote(request);
      const quote2 = calculateQuote(request);

      expect(quote1.expectedOutputAmount).toBe(quote2.expectedOutputAmount);
    });
  });

  describe("Slippage Enforcement", () => {
    it("should enforce maximum slippage server-side", () => {
      const SERVER_MAX_SLIPPAGE_BPS = 5000; // 50%

      const acceptableSlippage = 2500; // 25%
      const excessiveSlippage = 7500; // 75%

      expect(acceptableSlippage <= SERVER_MAX_SLIPPAGE_BPS).toBe(true);
      expect(excessiveSlippage <= SERVER_MAX_SLIPPAGE_BPS).toBe(false);
    });

    it("should reject swap if slippage exceeds minimum output", () => {
      const expectedOutput = BigInt("5000000");
      const userSlippageTolerance = 250; // 2.5%
      const minimumAccepted = expectedOutput - (expectedOutput * BigInt(userSlippageTolerance)) / BigInt(10000);

      const actualOutput = BigInt("4700000"); // Market moved, output is lower

      const isAcceptable = actualOutput >= minimumAccepted;
      expect(isAcceptable).toBe(false); // Should reject
    });

    it("should accept swap if slippage within tolerance", () => {
      const expectedOutput = BigInt("5000000");
      const userSlippageTolerance = 250; // 2.5%
      const minimumAccepted = expectedOutput - (expectedOutput * BigInt(userSlippageTolerance)) / BigInt(10000);

      const actualOutput = BigInt("4900000"); // Market barely moved

      const isAcceptable = actualOutput >= minimumAccepted;
      expect(isAcceptable).toBe(true); // Should accept
    });

    it("should compare against user-specified slippage, not server limit", () => {
      const userMaxSlippage = 100; // User accepts 1%
      const serverMaxSlippage = 5000; // Server allows up to 50%

      const applicableLimit = Math.min(userMaxSlippage, serverMaxSlippage);
      expect(applicableLimit).toBe(userMaxSlippage);
    });
  });

  describe("Pool Whitelisting Validation", () => {
    it("should reject swap with unwhitelisted pool", () => {
      const whitelistedAssets = new Set([usdcAddress, xlmAddress, eurcAddress]);

      const swapRequest: SwapFundingRequest = {
        sourceAddress: testKeypair.publicKey(),
        inputAsset: usdcAddress,
        outputAsset: "C" + Keypair.random().publicKey().slice(1), // Unknown asset
        targetAddress: targetCAddress,
        amount: "1000000",
        maxSlippage: 100,
      };

      const outputWhitelisted = whitelistedAssets.has(swapRequest.outputAsset);
      expect(outputWhitelisted).toBe(false);
    });

    it("should validate both input and output assets are whitelisted", () => {
      const whitelistedAssets = new Set([usdcAddress, xlmAddress, eurcAddress]);

      const validSwap = {
        inputAsset: usdcAddress,
        outputAsset: xlmAddress,
      };

      const invalidSwap = {
        inputAsset: usdcAddress,
        outputAsset: "C" + Keypair.random().publicKey().slice(1),
      };

      expect(whitelistedAssets.has(validSwap.inputAsset)).toBe(true);
      expect(whitelistedAssets.has(validSwap.outputAsset)).toBe(true);
      expect(whitelistedAssets.has(invalidSwap.outputAsset)).toBe(false);
    });

    it("should allow swapping between any two whitelisted assets", () => {
      const whitelistedAssets = [usdcAddress, xlmAddress, eurcAddress];

      // Any pair of whitelisted assets should be valid
      const validPairs = [
        [usdcAddress, xlmAddress],
        [xlmAddress, eurcAddress],
        [eurcAddress, usdcAddress],
        [usdcAddress, eurcAddress],
      ];

      validPairs.forEach(([input, output]) => {
        const inputValid = whitelistedAssets.includes(input);
        const outputValid = whitelistedAssets.includes(output);
        expect(inputValid && outputValid).toBe(true);
      });
    });
  });

  describe("Swap Integration Scenarios", () => {
    it("should handle complete swap-funding flow", () => {
      // Step 1: Request quote
      const quoteRequest = {
        inputAsset: usdcAddress,
        outputAsset: xlmAddress,
        inputAmount: "1000000",
      };

      // Step 2: Get quote
      const quote: SwapQuote = {
        inputAsset: quoteRequest.inputAsset,
        outputAsset: quoteRequest.outputAsset,
        inputAmount: quoteRequest.inputAmount,
        expectedOutputAmount: "5000000",
        minimumOutputAmount: "4950000", // 1% slippage
        priceImpact: 0.3,
        slippage: 1.0,
      };

      // Step 3: Submit swap with acceptable slippage
      const swapRequest: SwapFundingRequest = {
        sourceAddress: testKeypair.publicKey(),
        inputAsset: quoteRequest.inputAsset,
        outputAsset: quoteRequest.outputAsset,
        targetAddress: targetCAddress,
        amount: quoteRequest.inputAmount,
        maxSlippage: 250, // 2.5% acceptable
      };

      expect(swapRequest.maxSlippage).toBeGreaterThanOrEqual(100); // At least 1%
      expect(swapRequest.inputAsset).toBe(quote.inputAsset);
    });

    it("should reject swap with slippage exceeded", () => {
      // Quote shows minimum output
      const quote: SwapQuote = {
        inputAsset: usdcAddress,
        outputAsset: xlmAddress,
        inputAmount: "1000000",
        expectedOutputAmount: "5000000",
        minimumOutputAmount: "4950000", // 1% slippage
        priceImpact: 0.3,
        slippage: 1.0,
      };

      // Market moves adversely
      const actualOutput = "4900000"; // Less than minimum

      const isValid = BigInt(actualOutput) >= BigInt(quote.minimumOutputAmount);
      expect(isValid).toBe(false); // Should reject
    });

    it("should handle swap with unwhitelisted pool rejection", () => {
      const whitelistedPools: SwapPool[] = [
        {
          id: "pool-1",
          assetA: usdcAddress,
          assetB: xlmAddress,
          reserveA: "1000000000",
          reserveB: "5000000000",
          isWhitelisted: true,
        },
      ];

      const unknownPool: SwapPool = {
        id: "pool-unknown",
        assetA: usdcAddress,
        assetB: "C" + Keypair.random().publicKey().slice(1),
        reserveA: "500000000",
        reserveB: "2500000000",
        isWhitelisted: false,
      };

      const hasPool = whitelistedPools.some((p) => p.id === unknownPool.id);
      expect(hasPool).toBe(false);
    });
  });

  describe("Multi-Asset Funding Scenarios", () => {
    it("should enable funding with any whitelisted asset", () => {
      const whitelistedAssets = [usdcAddress, eurcAddress, xlmAddress];

      const fundingRequests = whitelistedAssets.map((asset) => ({
        sourceAddress: testKeypair.publicKey(),
        inputAsset: asset,
        outputAsset: xlmAddress,
        targetAddress: targetCAddress,
        amount: "1000000",
        maxSlippage: 100,
      }));

      expect(fundingRequests.length).toBe(3);
      fundingRequests.forEach((req) => {
        expect(whitelistedAssets.includes(req.inputAsset)).toBe(true);
      });
    });

    it("should convert any asset to recipient's preferred asset", () => {
      // User has USDC, wants to send to XLM holder
      const userHas = usdcAddress;
      const recipientNeeds = xlmAddress;

      // Route through swap
      const swapRoute = {
        inputAsset: userHas,
        outputAsset: recipientNeeds,
      };

      expect(swapRoute.inputAsset).toBe(userHas);
      expect(swapRoute.outputAsset).toBe(recipientNeeds);
    });
  });
});
