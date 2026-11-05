import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { manageDependencies } from "../../../firebase/functions/securityDependencies/manage.mjs";

// npm runs a linked package's postinstall without installing that package's
// development dependencies. Its parent owns the actual installed toolchain.
export async function isUninstalledWorkspaceLink(workspace, initialDirectory, lifecycle) {
  if (lifecycle !== "postinstall" || !initialDirectory || existsSync(resolve(workspace, "node_modules"))) return false;
  const root = await realpath(workspace), parent = await realpath(initialDirectory);
  if (root === parent) return false;
  let lock;
  try { lock = JSON.parse(await readFile(resolve(parent, "package-lock.json"), "utf8")); }
  catch { return false; }
  return Object.values(lock.packages ?? {}).some(item => item.link === true
    && typeof item.resolved === "string" && resolve(parent, item.resolved) === root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = fileURLToPath(new URL("../", import.meta.url));
  if (await isUninstalledWorkspaceLink(workspace, process.env.INIT_CWD, process.env.npm_lifecycle_event)) {
    console.log("Linked audit-registry has no installed toolchain; the installing workspace verifies its own dependencies.");
  } else {
    console.log(JSON.stringify(await manageDependencies([workspace], { verify: false, production: true })));
  }
}
