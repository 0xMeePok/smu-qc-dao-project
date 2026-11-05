import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isUninstalledWorkspaceLink } from "../contracts/audit-registry/scripts/install-security.mjs";

const root = await mkdtemp(join(tmpdir(), "qc-linked-security-"));
after(() => rm(root, { recursive: true, force: true }));
const workspace = join(root, "audit-registry"), parent = join(root, "funding-escrow");
await mkdir(workspace); await mkdir(parent);
const lock = { packages: { "node_modules/audit-registry": { resolved: "../audit-registry", link: true } } };
await writeFile(join(parent, "package-lock.json"), JSON.stringify(lock));

test("linked source without its own development install can defer only its postinstall", async () => {
  assert.equal(await isUninstalledWorkspaceLink(workspace, parent, "postinstall"), true);
  assert.equal(await isUninstalledWorkspaceLink(workspace, parent, "pretest"), false);
  assert.equal(await isUninstalledWorkspaceLink(workspace, parent, ""), false);
});
test("standalone installation and absent parent context cannot defer", async () => {
  assert.equal(await isUninstalledWorkspaceLink(workspace, workspace, "postinstall"), false);
  assert.equal(await isUninstalledWorkspaceLink(workspace, undefined, "postinstall"), false);
});
test("an ordinary dependency record or unrelated link does not authorize deferral", async () => {
  const other = join(root, "other"); await mkdir(other);
  await writeFile(join(other, "package-lock.json"), JSON.stringify({ packages: { zod: { resolved: "../audit-registry" } } }));
  assert.equal(await isUninstalledWorkspaceLink(workspace, other, "postinstall"), false);
  await writeFile(join(other, "package-lock.json"), JSON.stringify({ packages: { zod: { resolved: "../funding-escrow", link: true } } }));
  assert.equal(await isUninstalledWorkspaceLink(workspace, other, "postinstall"), false);
});
test("missing or malformed lockfiles do not authorize deferral", async () => {
  const other = join(root, "missing"); await mkdir(other);
  assert.equal(await isUninstalledWorkspaceLink(workspace, other, "postinstall"), false);
  await writeFile(join(other, "package-lock.json"), "invalid JSON");
  assert.equal(await isUninstalledWorkspaceLink(workspace, other, "postinstall"), false);
});
test("an installed linked toolchain must always be patched and verified", async () => {
  await mkdir(join(workspace, "node_modules"));
  assert.equal(await isUninstalledWorkspaceLink(workspace, parent, "postinstall"), false);
});
