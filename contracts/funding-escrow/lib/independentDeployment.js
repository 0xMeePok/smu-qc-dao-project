import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Interface, getAddress, keccak256 } from "ethers";
import { runtimeMatches } from "./verifyDeployment.js";

export async function loadIndependentArtifacts(directory = new URL("../artifacts/", import.meta.url)) {
  const root = directory instanceof URL ? fileURLToPath(directory) : path.resolve(directory);
  const load = async name => {
    const artifact = JSON.parse(await fs.readFile(path.join(root, `contracts/${name}.sol/${name}.json`), "utf8"));
    if (typeof artifact.buildInfoId !== "string" || path.basename(artifact.buildInfoId) !== artifact.buildInfoId) throw new Error("Independent artifact requires its exact build-info identifier.");
    const build = JSON.parse(await fs.readFile(path.join(root, `build-info/${artifact.buildInfoId}.output.json`), "utf8"));
    const output = build.output?.contracts?.[`project/${artifact.sourceName}`]?.[name];
    if (!output?.evm?.deployedBytecode?.object || `0x${output.evm.bytecode.object}` !== artifact.bytecode) throw new Error("Independent artifact build-info mismatch.");
    return { ...artifact, deployedBytecode: `0x${output.evm.deployedBytecode.object}`,
      immutableReferences: output.evm.deployedBytecode.immutableReferences ?? {} };
  };
  const [factory, escrow] = await Promise.all([load("IndependentFundingFactory"), load("IndependentFundingEscrow")]);
  return { factory, escrow };
}

export async function verifyIndependentDeployment(provider, record, artifacts) {
  const address = value => {
    const result = getAddress(value);
    if (/^0x0{40}$/i.test(result)) throw new Error("A nonzero deployment address is required.");
    return result;
  };
  if (record.contractName !== "IndependentFundingFactory" || record.chainId !== 421614 || record.status !== "ready"
      || !Number.isSafeInteger(record.deploymentBlock) || record.deploymentBlock < 0) throw new Error("A confirmed independent deployment is required.");
  if (Number((await provider.getNetwork()).chainId) !== record.chainId) throw new Error("Wrong network.");
  const factoryAddress = address(record.factoryAddress), registryAddress = address(record.registryAddress);
  const tokenRegistryAddress = address(record.tokenRegistryAddress), platformSigner = address(record.platformSigner);
  if (artifacts.factory.contractName !== "IndependentFundingFactory" || artifacts.escrow.contractName !== "IndependentFundingEscrow") throw new Error("Wrong independent contract artifacts.");
  const code = await provider.getCode(factoryAddress);
  if (!runtimeMatches(code, artifacts.factory)) throw new Error("Independent factory bytecode mismatch.");
  if ((await provider.getCode(registryAddress)) === "0x" || (await provider.getCode(tokenRegistryAddress)) === "0x") throw new Error("Existing policy contracts are unavailable.");
  const read = async (target, abi, name, args = []) => {
    const iface = new Interface(abi);
    return iface.decodeFunctionResult(name, await provider.call({ to: target, data: iface.encodeFunctionData(name, args) }))[0];
  };
  const policyAbi = ["function auditRegistry() view returns(address)", "function platformSigner() view returns(address)",
    "function allowedTokens(address) view returns(bool)", "function tokenDecimals(address) view returns(uint8)"];
  const [registry, policy, signer, oldRegistry, oldSigner, oldFactory] = await Promise.all([
    read(factoryAddress, artifacts.factory.abi, "auditRegistry"), read(factoryAddress, artifacts.factory.abi, "tokenRegistry"),
    read(factoryAddress, artifacts.factory.abi, "platformSigner"), read(tokenRegistryAddress, policyAbi, "auditRegistry"),
    read(tokenRegistryAddress, policyAbi, "platformSigner"), read(registryAddress, ["function fundingFactory() view returns(address)"], "fundingFactory"),
  ]);
  if (address(registry) !== registryAddress || address(policy) !== tokenRegistryAddress || address(signer) !== platformSigner
      || address(oldRegistry) !== registryAddress || address(oldSigner) !== platformSigner || address(oldFactory) !== tokenRegistryAddress) {
    throw new Error("Independent factory identity or existing registry wiring mismatch.");
  }
  for (const token of record.tokens ?? []) {
    if (!await read(tokenRegistryAddress, policyAbi, "allowedTokens", [address(token.address)])
        || Number(await read(tokenRegistryAddress, policyAbi, "tokenDecimals", [address(token.address)])) !== token.decimals) {
      throw new Error("Configured token policy mismatch.");
    }
  }
  return { bytecodeMatches: true, wiringMatches: true, readOnly: true, factoryAddress, registryAddress,
    tokenRegistryAddress, platformSigner, factoryCodeHash: keccak256(code) };
}

export function independentConfig(record, artifacts) {
  if (record.status !== "ready" || record.chainId !== 421614 || !record.runtimeVerification?.bytecodeMatches
      || !record.runtimeVerification?.wiringMatches || record.runtimeVerification.factoryAddress?.toLowerCase() !== record.factoryAddress?.toLowerCase()) {
    throw new Error("Export requires a verified independent factory deployment.");
  }
  return { enabled: true, chainId: record.chainId, registryAddress: record.registryAddress,
    tokenRegistryAddress: record.tokenRegistryAddress, factoryAddress: record.factoryAddress,
    platformSigner: record.platformSigner, deploymentBlock: record.deploymentBlock,
    defaultReviewDays: 30, reviewDays: 30, tokens: record.tokens ?? [],
    factoryAbi: artifacts.factory.abi, escrowAbi: artifacts.escrow.abi };
}
