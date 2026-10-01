import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(scriptDirectory, "..");
const repositoryDirectory = path.resolve(frontendDirectory, "..");

function option(name) {
  const exact = `--${name}`;
  const inline = `${exact}=`;
  const index = process.argv.indexOf(exact);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find((argument) => argument.startsWith(inline))?.slice(inline.length);
}

function resolveInput(value, fallback) {
  return path.resolve(process.cwd(), value || fallback);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${file}: ${error.message}`);
  }
}

const deploymentFile = resolveInput(option("deployment"), path.join(
  repositoryDirectory,
  // The active cutover manifest is authoritative. deployments/ contains the
  // historical registry and must be selected explicitly for a historical build.
  "contracts/audit-registry/manifests/arbitrumSepolia.json",
));
const outputFile = resolveInput(option("output"), path.join(
  frontendDirectory,
  "src/config/auditRegistry.contract.json",
));

const deployment = readJson(deploymentFile, "deployment record");
const linked = deployment.contractName === "EscrowAuditRegistry" || Boolean(deployment.registry);
const artifactFile = resolveInput(option("artifact"), path.join(repositoryDirectory, linked
  ? "contracts/funding-escrow/artifacts/contracts/EscrowAuditRegistry.sol/EscrowAuditRegistry.json"
  : "contracts/audit-registry/artifacts/contracts/AuditRegistry.sol/AuditRegistry.json"));
const artifact = readJson(artifactFile, "Hardhat artifact");
const address = String(option("address") || (linked ? deployment.registry?.address : deployment.address) || "").trim();
const chainId = Number(option("chain-id") || deployment.chainId);

if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) {
  throw new Error("The selected Hardhat artifact does not contain an ABI.");
}
if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) {
  throw new Error("The selected deployment does not contain a valid contract address.");
}
if (!Number.isSafeInteger(chainId) || chainId <= 0) {
  throw new Error("The selected deployment does not contain a valid chain ID.");
}

// Deployment facts shown by the admin Platform Status tab. Omitted when --address
// points somewhere else, because they would then describe a different contract.
const registryDeployment = linked ? deployment.registry : deployment;
const sameDeployment = String(registryDeployment?.address || "").toLowerCase() === address.toLowerCase();
const deploymentMetadata = sameDeployment ? Object.fromEntries(Object.entries({
  blockNumber: Number.isSafeInteger(registryDeployment.blockNumber) ? registryDeployment.blockNumber : undefined,
  transactionHash: /^0x[0-9a-fA-F]{64}$/.test(registryDeployment.transactionHash ?? "") ? registryDeployment.transactionHash : undefined,
  deployedAt: typeof registryDeployment.deployedAt === "string" ? registryDeployment.deployedAt : undefined,
  verificationUrl: /^https:\/\//.test(registryDeployment.verification?.url ?? "") ? registryDeployment.verification.url : undefined,
}).filter(([, value]) => value !== undefined)) : {};

const config = {
  contractName: artifact.contractName || "AuditRegistry",
  chainId,
  address,
  ...(deployment.entityIdScheme ? { entityIdScheme: deployment.entityIdScheme } : {}),
  ...(Object.keys(deploymentMetadata).length ? { deployment: deploymentMetadata } : {}),
  abi: artifact.abi,
};

if (linked || artifact.contractName === "EscrowAuditRegistry") {
  if (!linked || artifact.contractName !== "EscrowAuditRegistry" || deployment.status !== "ready"
      || deployment.registry?.status !== "confirmed" || deployment.factory?.status !== "confirmed"
      || deployment.wiring?.status !== "confirmed" || deployment.entityIdScheme !== 2
      || chainId !== 421614 || Number(deployment.chainId) !== chainId
      || address.toLowerCase() !== String(deployment.registry?.address).toLowerCase()) {
    throw new Error("Select a ready, confirmed EscrowAuditRegistry deployment with confirmed factory wiring and entity ID scheme 2.");
  }
  const factoryAddress = deployment.factory.address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(factoryAddress) || /^0x0{40}$/i.test(factoryAddress)) throw new Error("Invalid factory address.");
  const loadArtifact = (flag, name) => {
    const value = readJson(resolveInput(option(flag), path.join(repositoryDirectory,
      `contracts/funding-escrow/artifacts/contracts/${name}.sol/${name}.json`)), name);
    if (value.contractName !== name || !Array.isArray(value.abi) || !value.abi.length) throw new Error(`Invalid ${name} artifact.`);
    return value.abi;
  };
  const tokens = deployment.tokenMetadata;
  if (!Array.isArray(tokens) || !tokens.length || tokens.some(token => !/^0x[0-9a-fA-F]{40}$/.test(token.address)
      || /^0x0{40}$/i.test(token.address) || typeof token.symbol !== "string" || !token.symbol || token.symbol.length > 32
      || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 77)
      || new Set(tokens.map(token => token.address.toLowerCase())).size !== tokens.length
      || new Set(tokens.map(token => token.symbol)).size !== tokens.length) {
    throw new Error("Provide unique token addresses/symbols and exact decimals in the confirmed deployment record.");
  }
  config.escrow = { factoryAddress, tokens: tokens.map(({ address, symbol, decimals }) => ({ address, symbol, decimals })),
    factoryAbi: loadArtifact("factory-artifact", "FundingEscrowFactory"), escrowAbi: loadArtifact("escrow-artifact", "FundingEscrow") };
  const grantsDeclared = deployment.capabilities?.includes("open-funding-grants") || Boolean(deployment.openFunding);
  if (grantsDeclared) {
    const grant = deployment.openFunding;
    const validAddress = value => /^0x[0-9a-fA-F]{40}$/.test(value || "") && !/^0x0{40}$/i.test(value);
    if (deployment.workflowVersion !== 2 || !deployment.capabilities?.includes("open-funding-grants")
        || grant?.version !== 1 || grant.verified !== true
        || String(grant.registryAddress).toLowerCase() !== address.toLowerCase()
        || String(grant.factoryAddress).toLowerCase() !== factoryAddress.toLowerCase()
        || !validAddress(grant.escrowDeployerAddress) || !validAddress(grant.openFundingPoolDeployerAddress)
        || String(deployment.escrowDeployer?.address).toLowerCase() !== grant.escrowDeployerAddress.toLowerCase()
        || String(deployment.openFundingPoolDeployer?.address).toLowerCase() !== grant.openFundingPoolDeployerAddress.toLowerCase()) {
      throw new Error("Open funding requires a verified grant deployment record bound to this registry, factory and creation helpers.");
    }
    config.escrow.openFundingPoolAbi = loadArtifact("open-funding-pool-artifact", "OpenFundingPool");
  }
}

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(config, null, 2)}\n`);
if (!option("output")) {
  fs.writeFileSync(path.join(repositoryDirectory, "firebase/functions/auditRegistry.contract.json"), `${JSON.stringify(config, null, 2)}\n`);
  if (config.escrow) {
    fs.writeFileSync(path.join(repositoryDirectory, "firebase/functions/escrowRegistry.abis.json"), `${JSON.stringify({
      registry: config.abi, factory: config.escrow.factoryAbi, escrow: config.escrow.escrowAbi,
      ...(config.escrow.openFundingPoolAbi ? { openFundingPool: config.escrow.openFundingPoolAbi } : {}),
    }, null, 2)}\n`);
  }
}
console.log(`AuditRegistry frontend config synced to ${outputFile}`);
console.log(`Chain ${chainId}, address ${address}, ABI entries ${artifact.abi.length}`);
