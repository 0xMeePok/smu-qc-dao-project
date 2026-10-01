import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve embedded helper bytecode from the factory's exact compilation unit.
 * Hardhat may compile a standalone helper with different dependency remappings,
 * which changes Solidity metadata even when executable instructions agree.
 */
export function creationHelpersFromFactoryBuild(factory, buildOutput) {
  const contracts = buildOutput?.output?.contracts;
  const factoryOutput = contracts?.[`project/${factory.sourceName}`]?.[factory.contractName];
  if (!factoryOutput || `0x${factoryOutput.evm?.bytecode?.object}` !== factory.bytecode) {
    throw new Error("Factory build-info does not match its creation artifact.");
  }
  const helpers = {};
  for (const [key, name] of [["escrowDeployer", "FundingEscrowDeployer"], ["openFundingPoolDeployer", "OpenFundingPoolDeployer"]]) {
    const sourceName = `contracts/${name}.sol`;
    const output = contracts[`project/${sourceName}`]?.[name];
    if (!output?.evm?.deployedBytecode?.object || !Array.isArray(output.abi)) {
      throw new Error("Factory build-info is missing its creation helper output.");
    }
    helpers[key] = { contractName: name, sourceName, abi: output.abi,
      bytecode: `0x${output.evm.bytecode.object}`, deployedBytecode: `0x${output.evm.deployedBytecode.object}`,
      immutableReferences: output.evm.deployedBytecode.immutableReferences ?? {},
      linkReferences: output.evm.bytecode.linkReferences ?? {},
      deployedLinkReferences: output.evm.deployedBytecode.linkReferences ?? {}, buildInfoId: factory.buildInfoId };
  }
  return helpers;
}

export async function loadEscrowDeploymentArtifacts(directory = new URL("../artifacts/", import.meta.url)) {
  const root = directory instanceof URL ? fileURLToPath(directory) : path.resolve(directory);
  const load = async name => JSON.parse(await fs.readFile(path.join(root, `contracts/${name}.sol/${name}.json`), "utf8"));
  const [registry, factory] = await Promise.all([load("EscrowAuditRegistry"), load("FundingEscrowFactory")]);
  if (!factory.abi.some(item => item.type === "function" && item.name === "openFundingPoolDeployer")) return { registry, factory };
  if (typeof factory.buildInfoId !== "string" || path.basename(factory.buildInfoId) !== factory.buildInfoId) {
    throw new Error("Factory creation artifact requires its compiled build-info identifier.");
  }
  const output = JSON.parse(await fs.readFile(path.join(root, `build-info/${factory.buildInfoId}.output.json`), "utf8"));
  return { registry, factory, ...creationHelpersFromFactoryBuild(factory, output) };
}
