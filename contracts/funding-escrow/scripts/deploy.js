import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import hre, { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import { MAX_TOKEN_DECIMALS } from "../lib/tokenAmounts.js";
import { verifyEscrowDeployment } from "../lib/verifyDeployment.js";
import { loadEscrowDeploymentArtifacts } from "../lib/deploymentArtifacts.js";

const { ethers, networkName } = await network.create();
const chain = await ethers.provider.getNetwork();
if (networkName !== "arbitrumSepolia" || chain.chainId !== 421614n) {
  throw new Error("Deployment is restricted to Arbitrum Sepolia (421614).");
}

function address(variable) {
  const value = process.env[variable]?.trim();
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`Set ${variable} to a nonzero wallet address.`);
  }
  return ethers.getAddress(value);
}

const owner = address("ESCROW_OWNER_ADDRESS");
const platform = address("ESCROW_PLATFORM_SIGNER_ADDRESS");
const feeInput = process.env.ESCROW_FEE_BPS?.trim() ?? "";
if (!/^\d+$/.test(feeInput) || Number(feeInput) > 10000) {
  throw new Error("ESCROW_FEE_BPS must be an integer between 0 and 10000.");
}
const feeBps = Number(feeInput);
const rawTokens = process.env.ESCROW_TOKEN_ADDRESSES?.split(",").map(value => value.trim()) ?? [];
if (!rawTokens.length || rawTokens.some(value => !ethers.isAddress(value) || value === ethers.ZeroAddress)) {
  throw new Error("Set ESCROW_TOKEN_ADDRESSES to comma-separated deployed mock-token addresses.");
}
const tokens = rawTokens.map(ethers.getAddress);
if (new Set(tokens).size !== tokens.length) throw new Error("Duplicate token addresses.");
for (const tokenAddress of tokens) {
  if (await ethers.provider.getCode(tokenAddress) === "0x") throw new Error(`No token contract at ${tokenAddress}.`);
  const token = new ethers.Contract(tokenAddress, [
    "function decimals() view returns (uint8)", "function symbol() view returns (string)",
    "function balanceOf(address) view returns (uint256)",
  ], ethers.provider);
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals(), token.balanceOf(owner)]);
  if (decimals > BigInt(MAX_TOKEN_DECIMALS)) {
    throw new Error(`Unsupported token decimals (${decimals}) at ${tokenAddress}; maximum is ${MAX_TOKEN_DECIMALS}.`);
  }
  console.log(`Configured existing token: ${symbol} (${decimals} decimals), ${tokenAddress}`);
}

const [deployer] = await ethers.getSigners();
if (deployer.address !== owner) {
  throw new Error("The deployment signer must equal ESCROW_OWNER_ADDRESS to wire the registry. Transfer ownership using the two-step flow afterwards if needed.");
}
if (process.env.ESCROW_NEW_REGISTRY_ACK !== "true") {
  throw new Error("Set ESCROW_NEW_REGISTRY_ACK=true after planning the new registry address and application migration. Existing deployed AuditRegistry contracts cannot acquire this hook.");
}
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../deployments");
await fs.mkdir(directory, { recursive: true });
const record = { contractName: "EscrowAuditRegistry", entityIdScheme: 2, workflowVersion: 2,
  capabilities: ["pooled-funding", "open-funding-grants"], chainId: 421614, owner, platformSigner: platform, feeBps, tokens,
  status: "started", startedAt: new Date().toISOString(), registry: null, factory: null, wiring: null };
const file = path.join(directory, `arbitrumSepolia-${Date.now()}.json`);
const save = () => fs.writeFile(file, JSON.stringify(record, null, 2) + "\n");
await save();
async function deploy(name, constructorArgs, key) {
  const instance = await ethers.deployContract(name, constructorArgs);
  const tx = instance.deploymentTransaction();
  record[key] = { address: await instance.getAddress(), constructorArgs,
    transactionHash: tx.hash, blockNumber: null, status: "broadcast", verification: "not_requested" };
  await save();
  console.log(`${name} transaction: ${tx.hash}`);
  const receipt = await tx.wait(2, 180000);
  if (!receipt || receipt.status !== 1) throw new Error(`Unconfirmed ${name}; inspect ${file} before retrying.`);
  const block = await ethers.provider.getBlock(receipt.blockNumber);
  Object.assign(record[key], { status: "confirmed", blockNumber: receipt.blockNumber,
    deployedAt: new Date(block.timestamp * 1000).toISOString() });
  await save();
  return instance;
}
const registry = await deploy("EscrowAuditRegistry", [owner], "registry");
const factory = await deploy("FundingEscrowFactory", [owner, platform, tokens, feeBps, await registry.getAddress()], "factory");
record.escrowDeployer = { address: await factory.escrowDeployer(), status: "confirmed" };
record.openFundingPoolDeployer = { address: await factory.openFundingPoolDeployer(), status: "confirmed" };
await save();
const wiring = await registry.setFundingFactory(await factory.getAddress());
record.wiring = { transactionHash: wiring.hash, status: "broadcast" }; await save();
const wired = await wiring.wait(2, 180000);
if (!wired || wired.status !== 1) throw new Error(`Unconfirmed registry wiring; inspect ${file} before retrying.`);
record.wiring.status = "confirmed";
if (await registry.fundingFactory() !== await factory.getAddress()) throw new Error("Registry wiring verification failed.");
record.status = "ready";
record.tokenMetadata = await Promise.all(tokens.map(async address => ({ address,
  symbol: await new ethers.Contract(address, ["function symbol() view returns (string)"], ethers.provider).symbol(),
  decimals: Number(await factory.tokenDecimals(address)) })));
const verification = await verifyEscrowDeployment(ethers.provider, record, await loadEscrowDeploymentArtifacts());
record.openFunding = { version: 1, verified: verification.openFundingGrants, registryAddress: verification.address,
  factoryAddress: verification.factoryAddress, escrowDeployerAddress: verification.escrowDeployer,
  openFundingPoolDeployerAddress: verification.openFundingPoolDeployer };
record.runtimeVerification = { ...verification, verifiedAt: new Date().toISOString() };
await save();
console.log(`Registry: ${await registry.getAddress()}\nFactory: ${await factory.getAddress()}\nDeployment record: ${file}`);

if (process.env.ETHERSCAN_API_KEY?.trim()) {
  for (const [key, name] of [["registry", "EscrowAuditRegistry"], ["factory", "FundingEscrowFactory"]]) {
    try {
      await verifyContract({ address: record[key].address, constructorArgs: record[key].constructorArgs,
        contract: `contracts/${name}.sol:${name}`, provider: "etherscan" }, hre);
      record[key].verification = "verified";
    } catch {
      record[key].verification = "pending_retry";
      console.warn(`${name} is deployed; explorer verification needs a retry using the saved constructor arguments.`);
    }
    await save();
  }
}
