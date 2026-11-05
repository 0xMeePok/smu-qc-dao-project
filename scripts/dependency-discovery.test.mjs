import assert from "node:assert/strict";
import { test, after } from "node:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { manageDependencies, discoverZod } from "../firebase/functions/securityDependencies/manage.mjs";

const temporary = await mkdtemp(join(tmpdir(), "qc-dependency-discovery-"));
after(() => rm(temporary, { recursive: true, force: true }));
let sequence = 0;
async function workspace(entries = {}, name = "workspace") {
  const root = join(temporary, `${name}-${sequence++}`);
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...entries } }));
  return root;
}
async function pkg(path, name, version = "1.0.0") {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify({ name, version }));
}

test("discovery covers scopes, nested copies, aliases, workspace links and cycles", async () => {
  const root = await workspace();
  const direct = join(root, "node_modules/zod");
  const nested = join(root, "node_modules/@scope/parent/node_modules/validator-alias");
  const sibling = join(root, "linked-workspace");
  await pkg(direct, "zod", "3.25.76");
  await pkg(join(root, "node_modules/@scope/parent"), "@scope/parent");
  await pkg(nested, "zod", "3.22.4");
  await pkg(sibling, "linked-workspace");
  await pkg(join(sibling, "node_modules/zod"), "zod", "4.6.7");
  await symlink(sibling, join(root, "node_modules/linked-workspace"), "dir");
  await symlink(sibling, join(sibling, "node_modules/cycle"), "dir");
  const found = await discoverZod(root);
  assert.equal(found.size, 3);
  assert.equal(found.get(await realpath(nested)), "3.22.4");
});

test("a locked copy cannot disappear or change version silently", async () => {
  const root = await workspace({ "node_modules/zod": { version: "3.25.76" } });
  await assert.rejects(manageDependencies([root]), /Locked Zod copy is missing/);
  await pkg(join(root, "node_modules/zod"), "zod", "3.22.4");
  await assert.rejects(manageDependencies([root]), /differs from lockfile/);
});

test("only explicitly selected production mode permits missing development copies", async () => {
  const root = await workspace({ "node_modules/zod": { version: "4.6.7", dev: true } });
  await assert.rejects(manageDependencies([root]), /Locked Zod copy is missing/);
  assert.equal((await manageDependencies([root], { production: true })).packages, 0);
  const required = await workspace({ "node_modules/zod": { version: "4.6.7" } });
  await assert.rejects(manageDependencies([required], { production: true }), /Locked Zod copy is missing/);
});

test("aliases and unrecognized modern versions cannot bypass the exact patch manifest", async () => {
  const root = await workspace();
  await pkg(join(root, "node_modules/validator-alias"), "zod", "4.99.0");
  await assert.rejects(manageDependencies([root], { verify: false }), /Unsupported Zod/);
});

test("links outside the selected boundary are refused", async () => {
  const root = await workspace(), outside = await workspace();
  await pkg(join(outside, "node_modules/zod"), "zod", "3.25.76");
  await symlink(join(outside, "node_modules/zod"), join(root, "node_modules/zod"), "dir");
  await assert.rejects(discoverZod(root), /leaves verification boundary/);
});

test("skipped install scripts cannot pass verification; apply is idempotent", async () => {
  const root = await workspace({ "node_modules/zod": { version: "3.22.4" } });
  const source = fileURLToPath(new URL("../frontend/node_modules/@reown/appkit-wallet/node_modules/zod", import.meta.url));
  const target = join(root, "node_modules/zod");
  await cp(source, target, { recursive: true });
  const manifest = JSON.parse(await readFile(new URL("../firebase/functions/securityDependencies/zod-security-manifest.json", import.meta.url), "utf8"))["3.22.4"];
  // Restore official bytes in this disposable copy even if postinstall already ran.
  for (const [name, item] of Object.entries(manifest)) {
    const path = join(target, name);
    let text = await readFile(path, "utf8"), delta = 0;
    const digest = createHash("sha256").update(text).digest("hex");
    if (digest === item.before) continue;
    assert.equal(digest, item.after);
    const edits = item.edits.map(edit => {
      const offset = edit.offset + delta;
      delta += edit.after.length - edit.before.length;
      return { ...edit, offset };
    });
    // Compare hashes in the patcher; reversals never touch installed packages.
    for (const edit of edits.reverse()) text = text.slice(0, edit.offset) + edit.before + text.slice(edit.offset + edit.after.length);
    await writeFile(path, text);
  }
  await assert.rejects(manageDependencies([root]), /patch missing or changed/);
  assert.equal((await manageDependencies([root], { verify: false })).filesPatched, 3);
  assert.equal((await manageDependencies([root])).packages, 1);
  assert.equal((await manageDependencies([root], { verify: false })).filesPatched, 0);
  await writeFile(join(target, "lib/types.js"), "// Unexpected package bytes\n");
  await assert.rejects(manageDependencies([root]), /patch missing or changed/);
});
