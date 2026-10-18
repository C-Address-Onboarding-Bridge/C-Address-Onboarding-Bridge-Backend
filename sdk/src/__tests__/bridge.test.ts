import { describe, it, expect, vi, afterEach } from "vitest";
import { BridgeClient } from "../bridge";
import type { BridgeConfig } from "../types";

const config: BridgeConfig = {
  baseUrl: "https://example.test",
  maxRetries: 3,
};

describe("BridgeClient.shouldRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not retry non-BridgeError errors and rethrows the original error", async () => {
    const typeError = new TypeError("invalid json");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(typeError),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new BridgeClient(config);

    await expect(
      client.request({ path: "/api/v1/quote", method: "GET" }),
    ).rejects.toBe(typeError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
