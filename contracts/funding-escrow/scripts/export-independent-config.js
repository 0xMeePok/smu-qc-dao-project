import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { independentConfig, loadIndependentArtifacts } from "../lib/independentDeployment.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const artifacts = await loadIndependentArtifacts();
const flag = process.argv.indexOf("--deployment");
const deploymentFile = flag >= 0 ? process.argv[flag + 1] : process.argv.find(value => value.startsWith("--deployment="))?.slice(13);
const outputFiles = ["frontend/src/config/independentFunding.contract.json", "firebase/functions/independentFunding.contract.json"]
  .map(file => path.join(repository, file));
let config;
if (deploymentFile) {
  config = independentConfig(JSON.parse(await fs.readFile(deploymentFile, "utf8")), artifacts);
} else {
  const existing = JSON.parse(await fs.readFile(outputFiles[0], "utf8"));
  if (existing.enabled) throw new Error("Provide a confirmed, verified deployment record before replacing an enabled config.");
  config = { ...existing, enabled: false, factoryAbi: artifacts.factory.abi, escrowAbi: artifacts.escrow.abi };
}
for (const file of outputFiles) await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n");
console.log(`Exported independent interfaces to both standalone configs (${config.enabled ? "verified deployment" : "disabled until deployment"}).`);
