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

const artifactFile = resolveInput(option("artifact"), path.join(
  repositoryDirectory,
  "contracts/audit-registry/artifacts/contracts/AuditRegistry.sol/AuditRegistry.json",
));
const deploymentFile = resolveInput(option("deployment"), path.join(
  repositoryDirectory,
  "contracts/audit-registry/deployments/arbitrumSepolia.json",
));
const outputFile = resolveInput(option("output"), path.join(
  frontendDirectory,
  "src/config/auditRegistry.contract.json",
));

const artifact = readJson(artifactFile, "Hardhat artifact");
const deployment = readJson(deploymentFile, "deployment record");
const address = String(option("address") || deployment.address || "").trim();
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

const config = {
  contractName: artifact.contractName || "AuditRegistry",
  chainId,
  address,
  abi: artifact.abi,
};

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(config, null, 2)}\n`);
console.log(`AuditRegistry frontend config synced to ${outputFile}`);
console.log(`Chain ${chainId}, address ${address}, ABI entries ${artifact.abi.length}`);
