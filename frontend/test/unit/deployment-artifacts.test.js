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

it("the shipped app defers pages but never wallet helpers needed after a deployment", { timeout: 120_000 }, async () => {
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
  const entry = chunks.find(chunk => chunk.isEntry);
  assert.ok(entry.dynamicImports.length > 0, "Page code must be deferred until navigation");
  for (const chunk of chunks.filter(chunk => !chunk.isEntry)) {
    assert.deepEqual(chunk.dynamicImports, [], `${chunk.fileName} must not fetch wallet helpers mid-operation`);
  }
  const initial = new Set();
  const visit = file => {
    if (initial.has(file)) return;
    initial.add(file);
    chunks.find(chunk => chunk.fileName === file)?.imports.forEach(visit);
  };
  visit(entry.fileName);
  for (const page of ["AdminPage.jsx", "ProposalDetailPage.jsx", "CreateProposalPage.jsx", "RoleViews.jsx"]) {
    const chunk = chunks.find(chunk => Object.keys(chunk.modules).some(id => id.endsWith(`/${page}`)));
    assert.ok(chunk && !initial.has(chunk.fileName), `${page} must not be in the initial download`);
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
        ["open-funding-pool-artifact", "OpenFundingPool", configured.escrow.openFundingPoolAbi],
      ].filter(([, , abi]) => Array.isArray(abi) && abi.length)) {
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
    // Platform Status shows these deployment facts for the active registry.
    const registry = active.registry ?? active;
    assert.deepEqual(actual.deployment, Object.fromEntries(Object.entries({
      blockNumber: registry.blockNumber,
      transactionHash: registry.transactionHash,
      deployedAt: registry.deployedAt,
      verificationUrl: registry.verification?.url,
    }).filter(([, value]) => value !== undefined)));
    assert.deepEqual(configured.deployment, actual.deployment);
    const backend = JSON.parse(await readFile(path.join(repositoryDirectory, "firebase/functions/auditRegistry.contract.json"), "utf8"));
    assert.deepEqual(backend, configured);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("the registry sync omits deployment facts when --address selects a different contract", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qc-registry-sync-"));
  try {
    const output = path.join(directory, "registry.json");
    execFileSync(process.execPath, [
      path.join(frontendDirectory, "scripts/sync-audit-registry.mjs"),
      "--artifact", path.join(repositoryDirectory, "contracts/audit-registry/legacy/pre-escrow-arbitrumSepolia.contract.json"),
      "--deployment", path.join(repositoryDirectory, "contracts/audit-registry/legacy/pre-escrow-arbitrumSepolia.deployment.json"),
      "--address", `0x${"1".repeat(40)}`,
      "--output", output,
    ], { cwd: directory, encoding: "utf8", maxBuffer: 4000 });
    const actual = JSON.parse(await readFile(output, "utf8"));
    assert.equal(actual.address, `0x${"1".repeat(40)}`);
    assert.equal(actual.deployment, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
