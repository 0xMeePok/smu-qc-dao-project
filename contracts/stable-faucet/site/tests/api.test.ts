import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import {
  addSecurityHeaders,
  handleFaucet,
  type FaucetEnvironment,
} from "../lib/faucet";

const configuredEnvironment: FaucetEnvironment = {
  ARBITRUM_SEPOLIA_RPC_URL: "https://sepolia-rollup.arbitrum.io/rpc",
  FAUCET_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  XSGD_TOKEN_ADDRESS: "0xC2FE292771719Ae948506bab3c156A622de9a415",
  USDT_TOKEN_ADDRESS: "0x5f079A5934C864D6881EF30cf74Fe1363F58B856",
  USDC_TOKEN_ADDRESS: "0x4CBf2C15243678206dF8F248D01a0e117C8ce0cd",
};

function post(body: unknown) {
  return new Request("https://faucet.example/api/faucet", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vercel-forwarded-for": "203.0.113.10",
    },
    body: JSON.stringify(body),
  });
}

describe("faucet API boundary", () => {
  it("exposes no configuration endpoint", async () => {
    const response = await handleFaucet(
      new Request("https://faucet.example/api/faucet"),
      {},
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("rejects oversized request bodies", async () => {
    const response = await handleFaucet(
      post({ padding: "x".repeat(9_000) }),
      {},
    );
    expect(response.status).toBe(413);
  });

  it("requires the recipient wallet to be the signer", async () => {
    const signer = Wallet.createRandom();
    const recipient = Wallet.createRandom().address;
    const issuedAt = Math.floor(Date.now() / 1_000);
    const signature = await signer.signMessage(
      [
        "TAP Faucet Mint",
        "Token: XSGD",
        `Recipient: ${recipient}`,
        "Chain ID: 421614",
        `Issued At: ${issuedAt}`,
      ].join("\n"),
    );
    const response = await handleFaucet(
      post({ token: "XSGD", recipient, issuedAt, signature }),
      configuredEnvironment,
    );
    expect(response.status).toBe(401);
  });

  it("adds defensive response headers", () => {
    const response = addSecurityHeaders(new Response("ok"));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});
