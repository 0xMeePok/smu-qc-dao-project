import { describe, expect, it } from "vitest";
import { readFaucetResult } from "../src/api-client";

describe("faucet response parsing", () => {
  it("reads JSON faucet responses", async () => {
    const result = await readFaucetResult(
      Response.json({ txHash: "0x1234" }),
    );
    expect(result).toEqual({ txHash: "0x1234" });
  });

  it("does not expose or parse a plain-text platform error as JSON", async () => {
    const result = await readFaucetResult(
      new Response("A server error has occurred", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(result).toEqual({
      error:
        "The faucet service is temporarily unavailable. Please try again shortly.",
    });
  });

  it("handles malformed JSON without exposing parser details", async () => {
    const result = await readFaucetResult(
      new Response("not json", {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(result).toEqual({ error: "The faucet returned an invalid response." });
  });
});
