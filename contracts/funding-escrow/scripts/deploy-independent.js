import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";
import { independentConfig, loadIndependentArtifacts, verifyIndependentDeployment } from "../lib/independentDeployment.js";

// Additive only: this script never writes existing registry/factory contracts or audit configs.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const main = JSON.parse(await fs.readFile(path.join(repository, "firebase/functions/auditRegistry.contract.json"), "utf8"));
const configFiles = ["frontend/src/config/independentFunding.contract.json", "firebase/functions/independentFunding.contract.json"].map(file => path.join(repository, file));
const { ethers, networkName } = await network.create();
if (networkName !== "arbitrumSepolia" || (await ethers.provider.getNetwork()).chainId !== 421614n) throw new Error("Independent deployment is restricted to Arbitrum Sepolia.");
const artifacts = await loadIndependentArtifacts();
const exportVerified = async (record, alreadyVerified = false) => {
  if (!alreadyVerified) record.runtimeVerification = await verifyIndependentDeployment(ethers.provider, record, artifacts);
  const config = independentConfig(record, artifacts);
  for (const file of configFiles) await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n");
};
const reuseFile = process.env.INDEPENDENT_FUNDING_DEPLOYMENT_RECORD?.trim();
if (reuseFile) {
  const record = JSON.parse(await fs.readFile(reuseFile, "utf8"));
  if (record.registryAddress?.toLowerCase() !== main.address.toLowerCase()
      || record.tokenRegistryAddress?.toLowerCase() !== main.escrow.factoryAddress.toLowerCase()) throw new Error("Saved deployment belongs to another registry.");
  if (record.status !== "ready" && record.transactionHash) {
    const receipt = await ethers.provider.getTransactionReceipt(record.transactionHash);
    if (!receipt || receipt.status !== 1 || receipt.contractAddress?.toLowerCase() !== record.factoryAddress?.toLowerCase()) throw new Error("Saved factory transaction is not confirmed; no new transaction was submitted.");
    if (await ethers.provider.getBlockNumber() < receipt.blockNumber + 1) throw new Error("Wait for the saved factory transaction's successor block.");
    record.status = "ready";
    record.deploymentBlock = receipt.blockNumber;
  }
  await exportVerified(record);
  await fs.writeFile(reuseFile, JSON.stringify(record, null, 2) + "\n");
  console.log(`Reused verified independent factory ${record.factoryAddress}; no transaction submitted.`);
} else {
  for (const file of configFiles) {
    if (JSON.parse(await fs.readFile(file, "utf8")).enabled) throw new Error("Independent config is already enabled. Reuse its saved deployment record rather than creating another factory.");
  }
  if (process.env.INDEPENDENT_FUNDING_NEW_FACTORY_ACK !== "true") throw new Error("Set INDEPENDENT_FUNDING_NEW_FACTORY_ACK=true to deploy one additive independent factory.");
  const [deployer] = await ethers.getSigners();
  const policy = new ethers.Contract(main.escrow.factoryAddress, ["function owner() view returns(address)", "function platformSigner() view returns(address)", "function auditRegistry() view returns(address)"], ethers.provider);
  const [owner, platformSigner, registryAddress] = await Promise.all([policy.owner(), policy.platformSigner(), policy.auditRegistry()]);
  if (deployer.address.toLowerCase() !== owner.toLowerCase() || registryAddress.toLowerCase() !== main.address.toLowerCase()) throw new Error("Deployment signer must own the current token policy, and its registry must match the application.");
  for (const actor of [...new Set([deployer.address.toLowerCase(), platformSigner.toLowerCase()])]) {
    const [latest, pending] = await Promise.all([ethers.provider.getTransactionCount(actor, "latest"), ethers.provider.getTransactionCount(actor, "pending")]);
    if (latest !== pending) throw new Error("A deployment/platform signer transaction is pending. Wait for confirmation before deploying.");
  }
  const directory = path.join(repository, "contracts/funding-escrow/deployments");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `independent-arbitrumSepolia-${Date.now()}.json`);
  const record = { contractName: "IndependentFundingFactory", status: "started", chainId: 421614,
    registryAddress: main.address, tokenRegistryAddress: main.escrow.factoryAddress, platformSigner,
    factoryAddress: null, deploymentBlock: null, transactionHash: null, tokens: main.escrow.tokens,
    constructorArgs: [main.escrow.factoryAddress], startedAt: new Date().toISOString() };
  await fs.writeFile(file, JSON.stringify(record, null, 2) + "\n");
  const factory = await ethers.deployContract("IndependentFundingFactory", record.constructorArgs);
  const transaction = factory.deploymentTransaction();
  record.factoryAddress = await factory.getAddress();
  record.transactionHash = transaction.hash;
  record.status = "broadcast";
  await fs.writeFile(file, JSON.stringify(record, null, 2) + "\n");
  console.log(`Independent factory transaction ${transaction.hash}; saved record ${file}`);
  const receipt = await transaction.wait(2, 180000);
  if (!receipt || receipt.status !== 1) throw new Error(`Factory is not confirmed. Reuse saved record ${file}; do not submit another deployment.`);
  record.deploymentBlock = receipt.blockNumber;
  record.status = "ready";
  record.deployedAt = new Date((await ethers.provider.getBlock(receipt.blockNumber)).timestamp * 1000).toISOString();
  // Verification completes before either application config is enabled.
  record.runtimeVerification = await verifyIndependentDeployment(ethers.provider, record, artifacts);
  await fs.writeFile(file, JSON.stringify(record, null, 2) + "\n");
  await exportVerified(record, true);
  console.log(`Enabled verified independent factory ${record.factoryAddress}. Existing registry wiring and audit configs are unchanged.`);
}
