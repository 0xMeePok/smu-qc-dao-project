import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { build } from "vite";

const frontendDirectory = fileURLToPath(new URL("../../", import.meta.url));
const repositoryDirectory = path.resolve(frontendDirectory, "..");

it("the shipped app includes viem's contract-error helpers without deferred chunks", { timeout: 120_000 }, async () => {
  // Exercise the production config and real dependency graph. A missing lazy
  // helper masks ordinary registry reverts in tabs kept open during a deploy.
  const result = await build({
    root: frontendDirectory,
    configFile: path.join(frontendDirectory, "vite.config.js"),
    logLevel: "silent",
    build: { write: false },
  });
  const chunks = result.output.filter((item) => item.type === "chunk");
  assert.ok(chunks.some((chunk) => chunk.isEntry), "Expected a built application entry");
  assert.ok(chunks.some((chunk) => Object.keys(chunk.modules).some((id) => /viem\/.*\/ccip\.js$/.test(id))),
    "The real viem CCIP error path must be included in the build");
  for (const chunk of chunks) {
    assert.deepEqual(chunk.dynamicImports, [], `${chunk.fileName} must not need files removed by a later deploy`);
  }
});

it("the default registry sync preserves the active manifest's address and entity ID scheme", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qc-registry-sync-"));
  try {
    const output = path.join(directory, "registry.json");
    const configured = JSON.parse(await readFile(path.join(frontendDirectory, "src/config/auditRegistry.contract.json"), "utf8"));
    const extra = [];
    // Frontend CI does not compile Solidity. Supply the checked-in interfaces
    // explicitly so this checks default deployment selection on a clean clone.
    if (configured.escrow) {
      for (const [flag, contractName, abi] of [
        ["factory-artifact", "FundingEscrowFactory", configured.escrow.factoryAbi],
        ["escrow-artifact", "FundingEscrow", configured.escrow.escrowAbi],
      ]) {
        const file = path.join(directory, `${contractName}.json`);
        await writeFile(file, JSON.stringify({ contractName, abi }));
        extra.push(`--${flag}`, file);
      }
    }
    execFileSync(process.execPath, [
      path.join(frontendDirectory, "scripts/sync-audit-registry.mjs"),
      "--artifact", path.join(frontendDirectory, "src/config/auditRegistry.contract.json"),
      "--output", output,
      ...extra,
    ], { cwd: directory, encoding: "utf8", maxBuffer: 4000 });
    const actual = JSON.parse(await readFile(output, "utf8"));
    const active = JSON.parse(await readFile(path.join(repositoryDirectory, "contracts/audit-registry/manifests/arbitrumSepolia.json"), "utf8"));
    assert.equal(actual.address, active.registry?.address ?? active.address);
    assert.equal(actual.chainId, active.chainId);
    assert.equal(actual.entityIdScheme, active.entityIdScheme);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
