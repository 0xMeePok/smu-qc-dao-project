import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { escrowConfig } from "../../../firebase/functions/test/fixtures/escrowConfigFixture.js";

const script = fileURLToPath(new URL("../../scripts/sync-audit-registry.mjs", import.meta.url));

async function scenario(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "escrow-registry-sync-"));
  const file = name => path.join(directory, `${name}.json`);
  const record = { contractName: "EscrowAuditRegistry", entityIdScheme: 2, chainId: 421614, status: "ready",
    registry: { address: escrowConfig.address, status: "confirmed" },
    factory: { address: escrowConfig.escrow.factoryAddress, status: "confirmed" },
    wiring: { status: "confirmed" }, tokenMetadata: escrowConfig.escrow.tokens };
  try {
    for (const [name, abi] of [["EscrowAuditRegistry", escrowConfig.abi], ["FundingEscrowFactory", escrowConfig.escrow.factoryAbi], ["FundingEscrow", escrowConfig.escrow.escrowAbi]]) {
      await writeFile(file(name), JSON.stringify({ contractName: name, abi }));
    }
    const sync = async (deployment = record, extra = []) => {
      await writeFile(file("deployment"), JSON.stringify(deployment));
      return execFileSync(process.execPath, [script, "--deployment", file("deployment"), "--artifact", file("EscrowAuditRegistry"),
        "--factory-artifact", file("FundingEscrowFactory"), "--escrow-artifact", file("FundingEscrow"),
        "--output", file("output"), ...extra], { cwd: directory, encoding: "utf8", maxBuffer: 4000, stdio: "pipe" });
    };
    await run({ record, sync, file });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

it("generates linked registry, factory, escrow ABI and token metadata from a confirmed deployment", async () => {
  await scenario(async ({ sync, file }) => {
    await sync();
    assert.deepEqual(JSON.parse(await readFile(file("output"), "utf8")), escrowConfig);
  });
});

it("refuses an incomplete deployment or a new ABI paired with the previous address", async () => {
  await scenario(async ({ record, sync }) => {
    for (const patch of [{ status: "started" }, { wiring: { status: "broadcast" } }, { entityIdScheme: 1 },
      { registry: { ...record.registry, status: "broadcast" } }, { chainId: 1 }]) {
      await assert.rejects(sync({ ...record, ...patch }), /confirmed|wired/);
    }
    await assert.rejects(sync(record, ["--address", `0x${"9".repeat(40)}`]), /confirmed|wired/);
    await assert.rejects(sync({ address: record.registry.address, chainId: 421614, entityIdScheme: 2 }), /confirmed|wired/);
  });
});

it("refuses ambiguous token symbols, missing decimals and metadata beyond uint256 precision", async () => {
  await scenario(async ({ record, sync }) => {
    for (const tokens of [[], [{ ...record.tokenMetadata[0], decimals: 78 }],
      [{ ...record.tokenMetadata[0], symbol: undefined }],
      [...record.tokenMetadata, { ...record.tokenMetadata[0], address: `0x${"9".repeat(40)}` }]]) {
      await assert.rejects(sync({ ...record, tokenMetadata: tokens }), /unique token/);
    }
  });
});
