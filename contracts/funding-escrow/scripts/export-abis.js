import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const names = { registry: "EscrowAuditRegistry", factory: "FundingEscrowFactory", escrow: "FundingEscrow", openFundingPool: "OpenFundingPool" };
const bundle = {};
for (const [key, name] of Object.entries(names)) {
  const artifact = JSON.parse(await fs.readFile(path.join(directory, `artifacts/contracts/${name}.sol/${name}.json`), "utf8"));
  bundle[key] = artifact.abi;
}
// This is an interface bundle, never a claim that these contracts are deployed.
const argument = process.argv.indexOf("--output");
const output = argument >= 0 ? process.argv[argument + 1] : path.join(directory, "abis/open-funding.json");
if (!output) throw new Error("Provide a path after --output.");
await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
await fs.writeFile(output, JSON.stringify(bundle, null, 2) + "\n");
console.log(`Exported ${Object.keys(bundle).length} contract interfaces to ${path.resolve(output)}.`);
