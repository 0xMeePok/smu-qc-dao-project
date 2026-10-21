import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import { Wallet } from "ethers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { handleFaucet } from "../lib/faucet";
import { mintMessage } from "../src/wallet";

// No deployment configuration, .env, live RPC or existing private keys are read.
// The member has no ETH; a different account pays for an actual type-4 upgrade.
const chainId = 421614;
const member = Wallet.createRandom();
const minter = Wallet.createRandom();
const contractRoot = fileURLToPath(new URL("../../", import.meta.url));
const rpcMethods = [];
let server;
let closeChain;
let env;
let beforeToken;
let afterToken;
let upgrade;
let getCode;

beforeAll(async () => {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatEthers],
    solidity: { version: "0.8.28", settings: { evmVersion: "paris" } },
    networks: { local: {
      type: "edr-simulated", chainType: "generic", chainId,
      hardfork: "prague", initialBaseFeePerGas: 1_000_000,
    } },
  }, {}, contractRoot);
  const build = await hre.solidity.build(await hre.solidity.getRootFilePaths(), { quiet: true });
  if (!hre.solidity.isSuccessfulBuildResult(build)) throw new Error("Test contract compilation failed");
  const connection = await hre.network.create("local");
  closeChain = () => connection.close();
  const { ethers } = connection;
  const [sponsor] = await ethers.getSigners();
  await (await sponsor.sendTransaction({ to: minter.address, value: ethers.parseEther("1") })).wait();
  beforeToken = await ethers.deployContract("MockFaucetToken", ["Before", "XSGD", minter.address]);
  afterToken = await ethers.deployContract("MockFaucetToken", ["After", "USDC", minter.address]);
  await Promise.all([beforeToken.waitForDeployment(), afterToken.waitForDeployment()]);
  // STOP-only delegate intentionally has no ERC-1271 implementation. This proves
  // that code on an EOA must not force contract-signature validation.
  const deployed = await (await sponsor.sendTransaction({ data: "0x6001600c60003960016000f300" })).wait();
  const delegate = deployed.contractAddress;
  getCode = () => connection.provider.request({ method: "eth_getCode", params: [member.address, "latest"] });
  upgrade = async () => {
    expect(await getCode()).toBe("0x");
    const authorization = await member.authorize({ address: delegate, chainId, nonce: 0 });
    const transaction = await sponsor.sendTransaction({
      type: 4, to: member.address, authorizationList: [authorization], gasLimit: 100_000,
    });
    const receipt = await transaction.wait();
    expect(receipt.status).toBe(1);
    expect(transaction.type).toBe(4);
    expect(transaction.from).toBe(sponsor.address);
    expect(await getCode()).toBe(`0xef0100${delegate.slice(2).toLowerCase()}`);
    expect(await ethers.provider.getBalance(member.address)).toBe(0n);
    expect(await ethers.provider.getTransactionCount(member.address)).toBe(1);
  };

  // Real JSON-RPC transport to the isolated EVM; no ethers/contract mocks.
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const single = async (call) => {
      rpcMethods.push(call.method);
      try {
        // Keep the local chain's suggested tip within the production faucet's
        // 1 gwei safety ceiling. Execution and fee charging still use the EVM.
        const result = call.method === "eth_maxPriorityFeePerGas" ? "0x1" :
          await connection.provider.request({ method: call.method, params: call.params });
        return { jsonrpc: "2.0", id: call.id, result };
      } catch (error) {
        return { jsonrpc: "2.0", id: call.id, error: { code: error.code ?? -32000, message: error.message } };
      }
    };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(Array.isArray(body) ? await Promise.all(body.map(single)) : await single(body)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local RPC port");
  env = {
    ARBITRUM_SEPOLIA_RPC_URL: `http://127.0.0.1:${address.port}`,
    FAUCET_PRIVATE_KEY: minter.privateKey,
    XSGD_TOKEN_ADDRESS: await beforeToken.getAddress(),
    USDT_TOKEN_ADDRESS: await beforeToken.getAddress(),
    USDC_TOKEN_ADDRESS: await afterToken.getAddress(),
  };
}, 120_000);

afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await closeChain?.();
});

async function signedBody(token, issuedAt = Math.floor(Date.now() / 1000)) {
  return { token, recipient: member.address, issuedAt,
    signature: await member.signMessage(mintMessage(token, member.address, issuedAt)) };
}

function claim(body) {
  return handleFaucet(new Request("http://localhost/api/faucet", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env);
}

it("mints for the same zero-ETH wallet before and after a sponsored EIP-7702 upgrade", async () => {
  expect(await getCode()).toBe("0x");
  const before = await claim(await signedBody("XSGD"));
  expect(await before.json()).toMatchObject({ token: "XSGD", recipient: member.address, amount: "10000" });
  expect(before.status).toBe(200);
  expect(await beforeToken.balanceOf(member.address)).toBe(10_000_000_000n);

  await upgrade();
  const after = await claim(await signedBody("USDC"));
  const result = await after.json();
  expect(result).toMatchObject({ token: "USDC", recipient: member.address, amount: "10000" });
  expect(after.status).toBe(200);
  expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(await afterToken.balanceOf(member.address)).toBe(10_000_000_000n);
  expect(rpcMethods).toContain("eth_sendRawTransaction");
  expect(rpcMethods).not.toContain("eth_getCode");

  // A delegated account still has to own this exact, fresh signed request.
  const valid = await signedBody("USDC");
  const rpcCalls = rpcMethods.length;
  for (const changed of [
    { ...valid, recipient: Wallet.createRandom().address },
    { ...valid, token: "XSGD" },
    { ...valid, issuedAt: valid.issuedAt - 1 },
    { ...valid, signature: await Wallet.createRandom().signMessage(mintMessage("USDC", member.address, valid.issuedAt)) },
  ]) expect((await claim(changed)).status).toBe(401);
  expect((await claim(await signedBody("USDC", valid.issuedAt - 301))).status).toBe(400);
  expect(rpcMethods.length).toBe(rpcCalls);
  expect(await afterToken.balanceOf(member.address)).toBe(10_000_000_000n);
}, 30_000);
