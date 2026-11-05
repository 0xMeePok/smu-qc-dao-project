import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { patchZod } from "./patch-zod-security.mjs";

const inside = (root, path) => {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
};
async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function json(path) { return JSON.parse(await readFile(path, "utf8")); }

/** Enumerate package boundaries only; never walk arbitrary package source files. */
export async function discoverZod(workspace, { allowedRoot = workspace } = {}) {
  const root = await realpath(workspace), boundary = await realpath(allowedRoot);
  if (!inside(boundary, root)) throw new Error("Workspace is outside the dependency verification boundary");
  const seen = new Set(), found = new Map();
  async function packageAt(path) {
    const physical = await realpath(path);
    if (!inside(boundary, physical)) throw new Error(`Dependency link leaves verification boundary: ${path}`);
    if (seen.has(physical)) return;
    seen.add(physical);
    const pkgFile = resolve(physical, "package.json");
    if (!(await exists(pkgFile))) throw new Error(`Dependency has no package metadata: ${path}`);
    const pkg = await json(pkgFile);
    if (pkg.name === "zod") found.set(physical, pkg.version);
    await modulesAt(resolve(physical, "node_modules"));
  }
  async function modulesAt(path) {
    if (!(await exists(path))) return;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const target = resolve(path, entry.name);
      if (entry.name.startsWith("@")) {
        const scope = await realpath(target);
        if (!inside(boundary, scope)) throw new Error(`Scope link leaves verification boundary: ${target}`);
        for (const child of await readdir(scope, { withFileTypes: true })) {
          if (child.isDirectory() || child.isSymbolicLink()) await packageAt(resolve(scope, child.name));
        }
      } else await packageAt(target);
    }
  }
  if (!(await exists(resolve(root, "node_modules")))) throw new Error(`Install dependencies before verification: ${root}`);
  await modulesAt(resolve(root, "node_modules"));
  return found;
}

export async function manageDependencies(workspaces, { verify = true, production = false, allowedRoot } = {}) {
  if (!workspaces.length) throw new Error("Select at least one workspace");
  const all = new Map();
  for (const workspace of workspaces) {
    const root = await realpath(resolve(workspace));
    const lock = await json(resolve(root, "package-lock.json"));
    if (!lock.packages) throw new Error(`A package-lock with package inventory is required: ${root}`);
    const boundary = allowedRoot ? await realpath(allowedRoot) : await repositoryBoundary(root);
    const found = await discoverZod(root, { allowedRoot: boundary });
    for (const [name, item] of Object.entries(lock.packages)) {
      if (!name.endsWith("/zod") && item.name !== "zod") continue;
      if (!name.startsWith("node_modules/") || !inside(root, resolve(root, name))) {
        throw new Error(`Invalid locked dependency path: ${name}`);
      }
      const path = resolve(root, name);
      if (!(await exists(path))) {
        if (production && item.dev === true) continue;
        throw new Error(`Locked Zod copy is missing: ${path}`);
      }
      const physical = await realpath(path);
      if (found.get(physical) !== item.version) throw new Error(`Installed Zod differs from lockfile: ${path}`);
    }
    // Every installed copy, including aliases and linked workspace copies, must
    // pass the exact-version/file hash patcher. No modern-major exemption: v4
    // packages also expose the legacy v3 implementation.
    for (const [path, version] of found) all.set(path, version);
  }
  const result = all.size ? await patchZod([...all.keys()], { verify })
    : { packages: 0, filesPatched: 0, verified: verify };
  return { ...result, versions: [...new Set(all.values())].sort() };
}

async function repositoryBoundary(root) {
  let path = root;
  while (true) {
    if (await exists(resolve(path, ".git"))) return path;
    const parent = dirname(path);
    if (parent === path) return root;
    path = parent;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const mode = args.shift();
  if (!["--apply", "--verify"].includes(mode)) throw new Error("Use --apply or --verify [--production] [workspace ...]");
  const production = args.includes("--production");
  const workspaces = args.filter(arg => arg !== "--production");
  manageDependencies(workspaces.length ? workspaces : [process.cwd()], {
    verify: mode === "--verify", production,
  }).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
