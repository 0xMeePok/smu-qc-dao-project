#!/usr/bin/env node
// Locally maintained security backport. Package names and versions stay unchanged.
// Must be called explicitly after npm ci --ignore-scripts, before builds/tests/runtime.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const manifest = JSON.parse(readFileSync(new URL('./zod-security-manifest.json', import.meta.url), 'utf8'));
const hash = text => createHash('sha256').update(text).digest('hex');
export async function patchZod(packageRoots, { verify = false } = {}) {
  if (!packageRoots.length) throw new Error('Explicit Zod package directories are required');
  const planned = [];
  const seen = new Set();
  for (const root of packageRoots) {
    const directory = await realpath(resolve(root));
    if (seen.has(directory)) continue;
    seen.add(directory);
    const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    if (pkg.name !== 'zod' || !manifest[pkg.version]) throw new Error(`Unsupported Zod package/version: ${directory} (${pkg.name}@${pkg.version})`);
    for (const [relative, entry] of Object.entries(manifest[pkg.version])) {
      const filename = resolve(directory, relative);
      if (await realpath(filename) !== filename) throw new Error(`Refusing symlinked patch target: ${filename}`);
      const input = await readFile(filename, 'utf8');
      const digest = hash(input);
      if (digest === entry.after) continue;
      if (verify) throw new Error(`Security patch missing or changed: ${filename}`);
      if (digest !== entry.before) throw new Error(`Unexpected package content; refusing to patch: ${filename}`);
      let output = input;
      for (const edit of [...entry.edits].reverse()) {
        if (output.slice(edit.offset, edit.offset + edit.before.length) !== edit.before) throw new Error(`Patch context mismatch: ${filename}`);
        output = output.slice(0, edit.offset) + edit.after + output.slice(edit.offset + edit.before.length);
      }
      if (hash(output) !== entry.after) throw new Error(`Patch output hash mismatch: ${filename}`);
      planned.push({ filename, output });
    }
  }
  // All packages are checked before the first write. Interrupted writes fail verification.
  for (const { filename, output } of planned) await writeFile(filename, output);
  return { packages: seen.size, filesPatched: planned.length, verified: verify };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , mode, ...roots] = process.argv;
  if (!['--apply', '--verify'].includes(mode)) throw new Error('Usage: node patch-zod-security.mjs --apply|--verify /path/to/zod [...]');
  patchZod(roots, { verify: mode === '--verify' }).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
