import { describe, expect, it, vi } from "vitest";
import {
  CHAIN_HEX,
  mintMessage,
  shortAddress,
  switchToArbitrumSepolia,
  type EthereumProvider,
} from "../src/wallet";

describe("wallet request construction", () => {
  it("builds the exact server-verified mint message", () => {
    expect(mintMessage("USDC", "0x1234", 1_700_000_000)).toBe(
      [
        "TAP Faucet Mint",
        "Token: USDC",
        "Recipient: 0x1234",
        "Chain ID: 421614",
        "Issued At: 1700000000",
      ].join("\n"),
    );
  });

  it("shortens connected wallet addresses without changing their ends", () => {
    expect(shortAddress("0x1234567890abcdef")).toBe("0x1234…cdef");
  });

  it("requests the Arbitrum Sepolia chain", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    await switchToArbitrumSepolia({ request } as EthereumProvider);
    expect(request).toHaveBeenCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_HEX }],
    });
  });
});
