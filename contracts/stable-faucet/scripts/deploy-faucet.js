import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";

const EXPECTED_NETWORK = "arbitrumSepolia";
const EXPECTED_CHAIN_ID = 421614n;
const TOKENS = [
  ["Mock XSGD", "XSGD"],
  ["Mock Tether USD", "USDT"],
  ["Mock USD Coin", "USDC"],
];

function requireEnvironment() {
  const required = ["ARBITRUM_SEPOLIA_RPC_URL", "DEPLOYER_PRIVATE_KEY"];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing required .env values: ${missing.join(", ")}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.DEPLOYER_PRIVATE_KEY)) {
    throw new Error("DEPLOYER_PRIVATE_KEY is not a valid 32-byte private key");
  }
}

async function main() {
  requireEnvironment();
  const { ethers, networkName } = await network.create();
  if (networkName !== EXPECTED_NETWORK) throw new Error(`Refusing deployment on ${networkName}`);

  const connectedNetwork = await ethers.provider.getNetwork();
  if (connectedNetwork.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Refusing deployment on chain ${connectedNetwork.chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  if ((await ethers.provider.getBalance(deployerAddress)) === 0n) {
    throw new Error(`Deployer ${deployerAddress} has no Arbitrum Sepolia ETH`);
  }

  const deploymentFile = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "deployments",
    "arbitrumSepolia-faucet.json"
  );
  if (fs.existsSync(deploymentFile) && process.env.ALLOW_REDEPLOY !== "true") {
    throw new Error(`Deployment record already exists at ${deploymentFile}`);
  }

  const Factory = await ethers.getContractFactory("MockFaucetToken", deployer);
  const deployments = {};
  for (const [name, symbol] of TOKENS) {
    const token = await Factory.deploy(name, symbol, deployerAddress);
    const transaction = token.deploymentTransaction();
    await token.waitForDeployment();
    const receipt = await transaction.wait(2);
    if ((await token.decimals()) !== 6n) throw new Error(`${symbol} has unexpected decimals`);
    if ((await token.CLAIM_AMOUNT()) !== 10_000_000_000n) {
      throw new Error(`${symbol} has an unexpected claim amount`);
    }
    if ((await token.COOLDOWN()) !== 3_600n) {
      throw new Error(`${symbol} has an unexpected cooldown`);
    }
    if ((await token.owner()) !== deployerAddress) throw new Error(`${symbol} has an unexpected owner`);
    deployments[symbol] = {
      address: await token.getAddress(),
      transactionHash: transaction.hash,
      blockNumber: receipt.blockNumber,
      decimals: 6,
      claimAmount: "10000000000",
      cooldownSeconds: 3600,
    };
    console.log(`${symbol}: ${deployments[symbol].address}`);
  }

  const record = {
    network: EXPECTED_NETWORK,
    chainId: Number(EXPECTED_CHAIN_ID),
    owner: deployerAddress,
    tokens: deployments,
    deployedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(deploymentFile), { recursive: true });
  fs.writeFileSync(deploymentFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  console.log(`Deployment record: ${deploymentFile}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
