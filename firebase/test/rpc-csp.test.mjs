import assert from "node:assert/strict";
import fs from "node:fs";
import { it } from "node:test";
import { withRpcCsp } from "../scripts/configure-rpc-csp.mjs";

const config = JSON.parse(fs.readFileSync(new URL("../firebase.json", import.meta.url), "utf8"));
const csp = source => source.hosting.headers.flatMap(entry => entry.headers)
  .find(header => header.key === "Content-Security-Policy").value;

it("the checked-in browser policy allows the two operational public backups without RPC wildcards", () => {
  const policy = csp(config);
  assert.ok(policy.includes("https://sepolia-rollup.arbitrum.io"));
  assert.ok(policy.includes("https://arbitrum-sepolia-rpc.publicnode.com"));
  assert.equal(/connect-src[^;]*\*/.test(policy), false);
});

it("the deployment policy includes configured origins and excludes all credential paths and queries", () => {
  const updated = withRpcCsp(config, {
    primaryUrl: "https://arb-sepolia.g.alchemy.com/v2/private-test-path",
    backupUrls: '["https://backup.example.test/rpc?token=private-test-query"]',
  });
  const policy = csp(updated);
  assert.ok(policy.includes("https://backup.example.test"));
  assert.equal(policy.includes("private-test-path"), false);
  assert.equal(policy.includes("private-test-query"), false);
  assert.equal(policy.includes("?token="), false);
  assert.deepEqual(updated.firestore, config.firestore);
  assert.deepEqual(updated.storage, config.storage);
  assert.ok(policy.includes("frame-ancestors 'none'"));
  assert.ok(policy.includes("script-src 'self'"));
  assert.ok(policy.includes("upgrade-insecure-requests"));
});

it("a production deploy rejects insecure or wildcard RPC configuration", () => {
  for (const primaryUrl of ["http://127.0.0.1:8545", "https://*.example.test/rpc"]) {
    assert.throws(() => withRpcCsp(config, { primaryUrl }), /HTTPS without wildcard hosts/);
  }
});

it("a policy without connect-src fails deployment instead of silently weakening the CSP", () => {
  const invalid = structuredClone(config);
  invalid.hosting.headers.flatMap(entry => entry.headers)
    .find(header => header.key === "Content-Security-Policy").value = "default-src 'self'";
  assert.throws(() => withRpcCsp(invalid), /declare connect-src/);
});

it("GitHub Actions provides backup configuration to both the functions runtime and hosting build", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");
  assert.match(workflow, /ARBITRUM_SEPOLIA_RPC_BACKUP_URLS:.*secrets\.ARBITRUM_SEPOLIA_RPC_BACKUP_URLS/);
  assert.match(workflow, /VITE_ARBITRUM_SEPOLIA_RPC_BACKUP_URLS:.*vars\.VITE_ARBITRUM_SEPOLIA_RPC_BACKUP_URLS/);
  assert.match(workflow, /node firebase\/scripts\/configure-rpc-csp\.mjs\n\s+npm run build --prefix frontend/);
  assert.match(workflow, /ARBITRUM_SEPOLIA_RPC_BACKUP_URLS=%s/);
});
