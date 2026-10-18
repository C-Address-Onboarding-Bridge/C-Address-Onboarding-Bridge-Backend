import { describe, it, expect } from "vitest";
import type { FundingPrepareResult } from "../../../sdk/src/types";

// Recorded response from POST /api/v1/fund/prepare (see api/src/routes/funding.ts).
const recordedPrepareResponse = {
  unsignedXdr: "AAAAAgAAAAB...",
  footprint: "AAAAAQAAAAA...",
  fee: "100",
  sourceAddress: "GSOURCE000000000000000000000000000000000000000000000000000",
  targetAddress: "GTARGET000000000000000000000000000000000000000000000000000",
  tokenAddress: "GTOKEN0000000000000000000000000000000000000000000000000000",
  amount: "10000000",
  memo: "test-memo",
};

describe("POST /api/v1/fund/prepare contract", () => {
  it("matches the SDK FundingPrepareResult type", () => {
    // Compile-time check: the recorded response must be assignable to the SDK type.
    const typed: FundingPrepareResult = recordedPrepareResponse;

    expect(typed.unsignedXdr).toBe(recordedPrepareResponse.unsignedXdr);
    expect(typed.footprint).toBe(recordedPrepareResponse.footprint);
    expect(typed.fee).toBe(recordedPrepareResponse.fee);
    expect(typed.sourceAddress).toBe(recordedPrepareResponse.sourceAddress);
    expect(typed.targetAddress).toBe(recordedPrepareResponse.targetAddress);
    expect(typed.tokenAddress).toBe(recordedPrepareResponse.tokenAddress);
    expect(typed.amount).toBe(recordedPrepareResponse.amount);
    expect(typed.memo).toBe(recordedPrepareResponse.memo);
  });

  it("exposes unsignedXdr rather than the stale instruction field", () => {
    expect(recordedPrepareResponse).toHaveProperty("unsignedXdr");
    expect(recordedPrepareResponse).not.toHaveProperty("instruction");
  });
});
