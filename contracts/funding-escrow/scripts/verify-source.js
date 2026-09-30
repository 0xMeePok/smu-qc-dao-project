import fs from "node:fs/promises";
import hre from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";

// Explorer verification is separate from deployment: retrying this script can
// only submit source metadata and cannot deploy or send a wallet transaction.
const file = process.env.ESCROW_DEPLOYMENT_RECORD;
const selected = process.env.ESCROW_VERIFY_CONTRACT;
if (!file || !["registry", "factory"].includes(selected)) throw new Error("Set ESCROW_DEPLOYMENT_RECORD and ESCROW_VERIFY_CONTRACT=registry|factory.");
const record = JSON.parse(await fs.readFile(file, "utf8"));
if (record.status !== "ready" || record.chainId !== 421614 || record[selected]?.status !== "confirmed") {
  throw new Error("A confirmed Arbitrum Sepolia escrow deployment record is required.");
}
const name = selected === "registry" ? "EscrowAuditRegistry" : "FundingEscrowFactory";
const target = record[selected];
const evidence = new URL(`../deployments/source-verification-${target.address}.json`, import.meta.url);
const save = status => fs.writeFile(evidence, JSON.stringify({ address: target.address, contractName: name,
  chainId: 421614, status, checkedAt: new Date().toISOString() }, null, 2) + "\n");
const deadline = setTimeout(async () => {
  await save("pending");
  console.warn("Explorer verification is still pending. Retry source verification later; do not redeploy the contracts.");
  process.exit(2);
}, 120_000);
try {
  await verifyContract({ address: target.address, constructorArgs: target.constructorArgs,
    contract: `contracts/${name}.sol:${name}`, provider: "etherscan" }, hre);
  await save("verified");
} catch {
  await save("retry_required");
  console.error("Explorer verification needs a retry using the saved deployment record. No transaction was sent.");
  process.exitCode = 1;
} finally { clearTimeout(deadline); }
