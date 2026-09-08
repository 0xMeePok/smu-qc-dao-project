/**
 * Derives firebase.local.json from firebase.json for the Hosting emulator.
 *
 * The Hosting emulator serves the `headers` block verbatim, and the production
 * CSP names only deployed Google endpoints. Served locally that policy blocks
 * every call the app makes to the Firestore, Auth, Functions and Storage
 * emulators - the page loads and then does nothing, with the reason visible only
 * in the browser console.
 *
 * Generated rather than checked in as a second config, so there is one source of
 * truth for hosting rules, rewrites and every other header. A hand-maintained
 * copy drifts, and the copy that drifts is the one nobody deploys and therefore
 * nobody notices.
 *
 * The output is gitignored and must never be deployed: it trusts localhost.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Both spellings: 127.0.0.1 and localhost are different origins to the browser,
// and which one you get depends on how you typed the address. ws:// covers the
// Firestore emulator's WebChannel fallback.
export const LOCAL_ORIGINS = [
  "http://127.0.0.1:*", "http://localhost:*",
  "ws://127.0.0.1:*", "ws://localhost:*",
];

export function localContentSecurityPolicy(policy) {
  return policy
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    // Everything here is plain http on purpose. Left in place, this rewrites the
    // emulator URLs to https:// and every request fails to connect.
    .filter((directive) => directive !== "upgrade-insecure-requests")
    .map((directive) => (directive.startsWith("connect-src ")
      ? `${directive} ${LOCAL_ORIGINS.join(" ")}`
      : directive))
    .join("; ");
}

export function localHostingConfig(production) {
  const config = structuredClone(production);
  config.hosting.headers = config.hosting.headers.map((entry) => ({
    ...entry,
    headers: entry.headers
      // HSTS on localhost outlives this emulator run and pins every later
      // http://localhost service in the same browser to https.
      .filter((header) => header.key !== "Strict-Transport-Security")
      .map((header) => (header.key === "Content-Security-Policy"
        ? { ...header, value: localContentSecurityPolicy(header.value) }
        : header)),
  }));
  return config;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(HERE, "../firebase.json");
const TARGET = path.resolve(HERE, "../firebase.local.json");

// Only when run directly, so the transform above stays importable from tests.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const production = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
  fs.writeFileSync(TARGET, `${JSON.stringify(localHostingConfig(production), null, 2)}\n`);
  console.log(`[local-config] wrote ${path.relative(process.cwd(), TARGET)} — emulator use only, never deploy it`);
}
