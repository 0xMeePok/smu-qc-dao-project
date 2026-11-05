import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";
import { rollup } from "rollup";
import { optionalPeerStartupGuard } from "../../scripts/optional-peer-startup-guard.mjs";

const OPTIONAL_PEER = "__vite-optional-peer-dep:fixture-optional:fixture-sdk:false";
const MISSING_PEER = "Could not resolve fixture-optional imported by fixture-sdk";

async function fixture(run, { staticImport = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "qc-optional-peer-startup-"));
  let build;
  try {
    const sdk = path.join(directory, "node_modules/fixture-sdk/index.mjs");
    await mkdir(path.dirname(sdk), { recursive: true });
    await writeFile(sdk, `${staticImport ? 'import "fixture-optional";' : ""}
      export const startup = "ready";
      export async function loadOptional() {
        try { await import("fixture-optional"); return "unexpected success"; }
        catch (error) { return error.message; }
      }
    `);
    const input = path.join(directory, "entry.mjs");
    await writeFile(input, 'export { startup, loadOptional } from "./node_modules/fixture-sdk/index.mjs";');
    build = await rollup({
      input,
      plugins: [
        {
          name: "fixture-vite-optional-peer",
          resolveId(id) { if (id === "fixture-optional") return OPTIONAL_PEER; },
          // Match Vite's production behavior: the missing-peer module throws
          // when evaluated, rather than when its lazy import is requested.
          load(id) {
            if (id === OPTIONAL_PEER) return `throw new Error(${JSON.stringify(MISSING_PEER)}); export default {};`;
          },
        },
        optionalPeerStartupGuard(),
      ],
    });
    await run(build, directory);
  } finally {
    await build?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const outputOptions = {
  format: "es",
  entryFileNames: "[name].mjs",
  chunkFileNames: "[name]-[hash].mjs",
};

it("rejects the original vendor chunk configuration that eagerly evaluates a missing optional peer", async () => {
  await fixture(async build => {
    await assert.rejects(build.generate({
      ...outputOptions,
      manualChunks(id) {
        if (id.includes("/node_modules/") || id.startsWith("__vite-optional-peer-dep:")) return "vendor";
      },
    }), /optional peer dependency stub is eagerly loaded/);
  });
});

it("permits a lazy missing peer while the generated entry starts and its caller catches the rejection", async () => {
  await fixture(async (build, directory) => {
    const { output } = await build.write({
      ...outputOptions,
      dir: path.join(directory, "output"),
      manualChunks(id) { if (id.includes("/node_modules/")) return "vendor"; },
    });
    const peerChunk = output.find(item => item.type === "chunk" && OPTIONAL_PEER in item.modules);
    assert.ok(peerChunk?.isDynamicEntry, "The missing peer must remain a separate dynamic entry");
    const entry = output.find(item => item.type === "chunk" && item.isEntry);
    const application = await import(pathToFileURL(path.join(directory, "output", entry.fileName)).href);
    assert.equal(application.startup, "ready");
    assert.equal(await application.loadOptional(), MISSING_PEER);
  });
});

it("also rejects a missing peer reached through a static vendor dependency", async () => {
  await fixture(async build => {
    await assert.rejects(build.generate({
      ...outputOptions,
      manualChunks(id) { if (id.includes("/node_modules/")) return "vendor"; },
    }), /optional peer dependency stub is eagerly loaded/);
  }, { staticImport: true });
});
