import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

const firebaseConfig = JSON.parse(
  fs.readFileSync(new URL("../firebase.json", import.meta.url), "utf8"),
);
const indexes = JSON.parse(
  fs.readFileSync(new URL("../firestore.indexes.json", import.meta.url), "utf8"),
);
const functionsSource = fs.readFileSync(
  new URL("../functions/index.js", import.meta.url),
  "utf8",
);

function contentSecurityPolicy() {
  return firebaseConfig.hosting.headers
    .flatMap((entry) => entry.headers)
    .find((header) => header.key === "Content-Security-Policy")?.value;
}

describe("security deployment configuration", () => {
  it("allows only the QC DAO Cloud Functions endpoint", () => {
    const policy = contentSecurityPolicy();
    assert.ok(policy.includes("https://asia-southeast1-qcdao-a0c7a.cloudfunctions.net"));
    assert.equal(policy.includes("https://*.cloudfunctions.net"), false);
    assert.equal(policy.includes("https://*.googleapis.com"), false);
    assert.equal(policy.includes("wss://*.googleapis.com"), false);
  });

  it("[QCDAO-123] enforces App Check for production nonce calls", () => {
    assert.match(functionsSource, /enforceAppCheck:\s*process\.env\.FUNCTIONS_EMULATOR !== "true"/);
    assert.match(functionsSource, /consumeAppCheckToken:\s*false/);
  });

  it("enables TTL cleanup for nonce and rate-limit documents", () => {
    const ttlGroups = indexes.fieldOverrides
      .filter((entry) => entry.fieldPath === "expiresAt" && entry.ttl === true)
      .map((entry) => entry.collectionGroup)
      .sort();
    assert.deepEqual(ttlGroups, ["siweNonces", "siweRateLimits"]);
  });
});
