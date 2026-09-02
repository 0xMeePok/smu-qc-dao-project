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

console.log("Deployed CSP is present and restricted to documented endpoints.");
