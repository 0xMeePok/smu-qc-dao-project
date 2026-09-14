import { beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import { handleFaucet } from "../lib/faucet";
const rpc = vi.hoisted(() => ({ nextClaimAt: vi.fn(), mint: vi.fn(), estimate: vi.fn(), receipt: vi.fn() }));
vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  return { ...actual,
    JsonRpcProvider: class {
      async getNetwork() { return { chainId: 421614n }; }
      async getBalance() { return 10n ** 18n; }
      async getFeeData() { return { maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 1n }; }
      async getTransactionCount() { return 3; }
    },
    Contract: class {
      nextClaimAt = rpc.nextClaimAt;
      faucetMint = Object.assign(rpc.mint, { estimateGas: rpc.estimate });
    },
  };
});
const env = { ARBITRUM_SEPOLIA_RPC_URL: "https://rpc.example", FAUCET_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  XSGD_TOKEN_ADDRESS: `0x${"22".repeat(20)}`, USDT_TOKEN_ADDRESS: `0x${"33".repeat(20)}`, USDC_TOKEN_ADDRESS: `0x${"44".repeat(20)}` };
async function request(wallet = Wallet.createRandom()) {
  const recipient = wallet.address, issuedAt = Math.floor(Date.now() / 1000);
  const signature = await wallet.signMessage(["TAP Faucet Mint", "Token: USDC", `Recipient: ${recipient}`, "Chain ID: 421614", `Issued At: ${issuedAt}`].join("\n"));
  return new Request("https://faucet.example/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "USDC", recipient, issuedAt, signature }) });
}
beforeEach(() => {
  vi.resetAllMocks(); rpc.nextClaimAt.mockResolvedValue(0n); rpc.estimate.mockResolvedValue(100_000n);
  rpc.receipt.mockResolvedValue({ status: 1 }); rpc.mint.mockResolvedValue({ hash: `0x${"55".repeat(32)}`, wait: rpc.receipt });
});
describe("testnet wallet mint policy without external storage", () => {
  it("mints for a signed wallet with only the original RPC/key/token configuration", async () => {
    const wallet = Wallet.createRandom();
    const response = await handleFaucet(await request(wallet), env);
    expect(response.status).toBe(200); expect((await response.json()).recipient).toBe(wallet.address);
    expect(rpc.mint).toHaveBeenCalledWith(wallet.address, expect.objectContaining({ nonce: 3, gasLimit: 120_000n }));
  });
  it("honours the authoritative on-chain wallet cooldown before minting", async () => {
    rpc.nextClaimAt.mockResolvedValue(BigInt(Math.floor(Date.now() / 1000) + 3600));
    expect((await handleFaucet(await request(), env)).status).toBe(429);
    expect(rpc.mint).not.toHaveBeenCalled();
  });
  it("permits separate testing wallets while blocking concurrent duplicates locally", async () => {
    const wallet = Wallet.createRandom();
    const outcomes = await Promise.all([handleFaucet(await request(wallet), env), handleFaucet(await request(wallet), env)]);
    expect(outcomes.map((response) => response.status).sort()).toEqual([200, 429]);
    expect((await handleFaucet(await request(), env)).status).toBe(200);
    expect(rpc.mint).toHaveBeenCalledTimes(2);
  });
  it("allows retry after a rejected nonce race instead of charging a local cooldown", async () => {
    const wallet = Wallet.createRandom();
    rpc.mint.mockRejectedValueOnce(new Error("nonce already used"));
    expect((await handleFaucet(await request(wallet), env)).status).toBe(502);
    expect((await handleFaucet(await request(wallet), env)).status).toBe(200);
  });
  it("does not report an unconfirmed mint as successful", async () => {
    rpc.receipt.mockResolvedValue({ status: 0 });
    expect((await handleFaucet(await request(), env)).status).toBe(502);
  });
});
