import fs from "node:fs";
import { JsonRpcProvider } from "ethers";
import "dotenv/config";
import { verifyEscrowDeployment } from "../lib/verifyDeployment.js";

const flag = process.argv.findIndex(value => value === "--deployment");
const file = flag >= 0 ? process.argv[flag + 1] : process.argv.find(value => value.startsWith("--deployment="))?.slice(13);
if (!file) throw new Error("Pass --deployment=deployments/arbitrumSepolia-TIMESTAMP.json for the confirmed linked registry.");
const record = JSON.parse(fs.readFileSync(file, "utf8"));
const load = name => JSON.parse(fs.readFileSync(new URL(`../artifacts/contracts/${name}.sol/${name}.json`, import.meta.url)));
const provider = new JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC_URL);
try {
  console.log(JSON.stringify(await verifyEscrowDeployment(provider, record,
    { registry: load("EscrowAuditRegistry"), factory: load("FundingEscrowFactory") })));
} catch {
  console.error("Escrow registry verification failed. Check the confirmed record, production artifacts, network and wiring. No transaction was submitted.");
  process.exitCode = 1;
} finally { provider.destroy(); }
