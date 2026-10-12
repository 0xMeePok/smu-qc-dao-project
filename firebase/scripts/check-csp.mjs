import assert from "node:assert/strict";

const url = process.argv[2];
if (!url) throw new Error("Usage: node scripts/check-csp.mjs <deployed-url>");

const response = await fetch(url, { redirect: "follow" });
assert.equal(response.ok, true, `Hosting smoke request failed with HTTP ${response.status}`);

const policy = response.headers.get("content-security-policy") ?? "";
assert.ok(policy, "The deployed response has no Content-Security-Policy header");
assert.ok(
  policy.includes("https://asia-southeast1-qcdao-a0c7a.cloudfunctions.net"),
  "The deployed CSP does not allow the QC DAO function endpoint",
);
assert.equal(policy.includes("*.cloudfunctions.net"), false, "Cloud Functions wildcard remains live");
assert.equal(policy.includes("*.googleapis.com"), false, "Google APIs wildcard remains live");
assert.ok(
  policy.includes("https://firebasestorage.googleapis.com"),
  "The deployed CSP does not allow Cloud Storage, so posting attachments cannot upload or download",
);

// Email sign-in: Privy's API and wallet iframe, and the RPC its embedded wallet
// uses on Arbitrum Sepolia. Exact origins only - never a wildcard.
const directive = (name) => policy.split(";").map((part) => part.trim())
  .find((part) => part.startsWith(`${name} `)) ?? "";
assert.ok(directive("connect-src").includes("https://auth.privy.io"),
  "The deployed CSP blocks Privy's API, so nobody can sign in with email");
assert.ok(directive("connect-src").includes("https://arbitrum-sepolia.rpc.privy.systems"),
  "The deployed CSP blocks the embedded wallet's RPC, so wallet transactions cannot be sent");
assert.ok(directive("frame-src").includes("https://auth.privy.io"),
  "The deployed CSP blocks Privy's wallet iframe, so the embedded wallet cannot sign");
assert.equal(/\*\.(?:rpc\.)?privy\./.test(policy), false, "Privy wildcard remains live");

console.log("Deployed CSP is present and restricted to documented endpoints.");
