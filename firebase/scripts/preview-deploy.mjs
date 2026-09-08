#!/usr/bin/env node
/**
 * Deploys the frontend to a Hosting preview channel that talks to the REAL
 * production backend, then brings the two backend allow-lists into line with
 * whatever preview channels currently exist.
 *
 * Nothing about a channel is hardcoded or committed: the SIWE allow-list and the
 * bucket CORS origins are both derived from `hosting:channel:list` on every run,
 * so a new channel is picked up and an expired one drops off by itself.
 *
 * Firestore and Storage rules are project-global: a preview channel runs against
 * whatever is live, so a branch that changes rules cannot be tested on one until
 * those rules are deployed. `--backend` does that, and is opt-in because it
 * pushes to the shared project for everyone, not just this channel.
 *
 * Usage:
 *   node scripts/preview-deploy.mjs [channel] [--expires 7d] [--backend] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const firebaseDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(firebaseDir);
const PROJECT = "qcdao-a0c7a";
const BUCKET = `gs://${PROJECT}.firebasestorage.app`;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const withBackend = args.includes("--backend");
const channel = args.find((a) => !a.startsWith("--")) ?? "prod-twin";
const expIndex = args.indexOf("--expires");
const expires = expIndex === -1 ? "7d" : args[expIndex + 1];

const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, {
  cwd: opts.cwd ?? firebaseDir,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, ...opts.env },
});

// stdout is captured so it can be parsed, which means a failing CLI call throws
// with the entire buffer attached and Node prints it as one unreadable object
// wrapped in a stack trace. The CLI's own last lines are the actual diagnosis.
function step(label, cmd, cmdArgs, opts = {}) {
  try {
    return run(cmd, cmdArgs, opts);
  } catch (error) {
    console.error(`\n[preview] ${label} failed.\n`);
    const output = String(error.stdout ?? "").trim().split("\n").slice(-12).join("\n");
    if (output) console.error(output);
    process.exit(1);
  }
}

// Mirrors .github/workflows/deploy.yml, which passes the same two flags for the
// same reason: queueProposalAudit and recordProposalEdit both set `retry: true`,
// and the CLI refuses to deploy a failure policy without --force. Dropping the
// retry instead would be the wrong trade - a transient Firestore error would
// silently lose an audit entry, and both triggers are keyed to be idempotent
// precisely so a retry is safe.
const DEPLOY_FUNCTIONS = ["firebase", "deploy", "--only", "functions",
  "--project", PROJECT, "--non-interactive", "--force"];

// A shell variable outranks .env and .env.local, so the single .env stays the
// developer's local setup and only this build is forced onto production.
console.log("[preview] building the frontend against production…");
run("npm", ["run", "build", "--prefix", "frontend"], {
  cwd: repoRoot,
  env: { VITE_FIREBASE_USE_EMULATORS: "false" },
});

const assetsDir = path.join(firebaseDir, "public", "assets");
const bundle = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".js"))
  .map((f) => fs.readFileSync(path.join(assetsDir, f), "utf8")).join("");
if (!bundle.includes('VITE_FIREBASE_USE_EMULATORS:"false"') || !bundle.includes(PROJECT)) {
  console.error("[preview] refusing to deploy: the bundle is not wired to production.");
  process.exit(1);
}
console.log("[preview] bundle verified: production project, emulators off.");

if (dryRun) {
  console.log(`[preview] --dry-run: stopping before any deploy.${withBackend ? " --backend would deploy rules, indexes and functions." : ""}`);
  process.exit(0);
}

// Before the channel, so the site is never live against rules older than the
// bundle it serves. Rules are project-global; there is no per-channel copy.
if (withBackend) {
  console.log("[preview] --backend: deploying Firestore rules, indexes and Storage rules to the SHARED project…");
  step("rules deploy", "npx", ["firebase", "deploy", "--only",
    "firestore:rules,firestore:indexes,storage", "--project", PROJECT, "--non-interactive"]);
  console.log("[preview] backend rules updated.");
} else {
  console.log("[preview] rules and functions NOT deployed. If this branch changes");
  console.log("[preview] firestore.rules, storage.rules or functions/, re-run with --backend");
  console.log("[preview] or the channel tests the frontend against the live backend.");
}

console.log(`[preview] deploying channel "${channel}" (expires ${expires})…`);
const deployOut = run("npx", [
  "firebase", "hosting:channel:deploy", channel, "--expires", expires,
  "--project", PROJECT,
]);
const url = deployOut.match(/https:\/\/[a-z0-9-]+--[a-z0-9-]+\.web\.app/i)?.[0];
if (!url) {
  console.error("[preview] could not read the channel URL from the deploy output.");
  process.exit(1);
}
console.log(`\n[preview] ${url}`);

// Every live preview channel, so this run repairs channels made by earlier runs
// and forgets ones that have since expired.
const listed = JSON.parse(run("npx", [
  "firebase", "hosting:channel:list", "--project", PROJECT, "--json",
]));
const channels = listed.result?.channels ?? listed.channels ?? [];
const previewUrls = channels
  .filter((c) => !c.name.endsWith("/live") && c.url)
  .map((c) => c.url)
  .sort();
const previewHosts = previewUrls.map((u) => new URL(u).host);
console.log(`[preview] ${previewHosts.length} live preview channel(s).`);

// SIWE fails closed on an unknown Origin and cannot match a pattern, so the
// generated host has to be listed in full. Gitignored: regenerated every run.
const envPath = path.join(firebaseDir, "functions", `.env.${PROJECT}`);
const desired = `# Generated by scripts/preview-deploy.mjs. Preview channels only;\n`
  + `# the two Hosting domains are derived from the project id in siweOrigin.js.\n`
  + `SIWE_ALLOWED_HOSTS=${previewHosts.join(",")}\n`;
const currentEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
if (currentEnv !== desired) fs.writeFileSync(envPath, desired);
// --backend forces the deploy even when the allow-list is unchanged. Without
// that, a redeploy to an EXISTING channel skips this step entirely, and changed
// function code - a new trigger, say - silently never ships.
if (currentEnv !== desired || withBackend) {
  console.log(currentEnv !== desired
    ? "[preview] SIWE allow-list changed - redeploying functions…"
    : "[preview] --backend: redeploying functions…");
  step("functions deploy", "npx", DEPLOY_FUNCTIONS);
  console.log("[preview] functions updated.");
} else {
  console.log("[preview] SIWE allow-list already current; functions not redeployed (--backend forces it).");
}

// storage.cors.json holds only the permanent origins. The effective config is
// assembled here so no preview host is ever committed.
const corsPath = path.join(firebaseDir, "storage.cors.json");
const baseCors = JSON.parse(fs.readFileSync(corsPath, "utf8"));
const effective = structuredClone(baseCors);
effective[0].origin = [...new Set([...baseCors[0].origin, ...previewUrls])];

const applied = run("gcloud", [
  "storage", "buckets", "describe", BUCKET, "--project", PROJECT, "--format=json",
]);
const live = (JSON.parse(applied).cors_config ?? JSON.parse(applied).cors ?? [])[0]?.origin ?? [];
if (JSON.stringify([...live].sort()) !== JSON.stringify([...effective[0].origin].sort())) {
  const tmp = path.join(os.tmpdir(), `qcdao-cors-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(effective, null, 2));
  run("gcloud", ["storage", "buckets", "update", BUCKET, `--cors-file=${tmp}`, "--project", PROJECT]);
  fs.unlinkSync(tmp);
  console.log(`[preview] bucket CORS updated (${effective[0].origin.length} origins).`);
} else {
  console.log("[preview] bucket CORS already current.");
}

console.log(`\n[preview] ready: ${url}`);
console.log(`[preview] App Check is the one gate left: add ${new URL(url).host}`);
console.log("[preview] to the reCAPTCHA Enterprise key's allowed domains, or calls 401.");
