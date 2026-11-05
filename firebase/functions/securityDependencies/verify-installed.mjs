import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// This file is uploaded with Functions. Production installation applies the
// patch via postinstall; skipped or changed patches prevent service startup.
// Firebase's Node 22 emulator loads ESM via require(). Keep this startup module
// synchronous rather than making the entire Functions module graph async.
execFileSync(process.execPath, [fileURLToPath(new URL("manage.mjs", import.meta.url)),
  "--verify", "--production", fileURLToPath(new URL("../", import.meta.url))], {
  stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 64 * 1024,
});
