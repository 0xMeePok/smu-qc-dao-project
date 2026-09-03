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

  it("[BUT-OPD-020] ships Storage rules and allows the Storage endpoint", () => {
    // The rules file has to be declared, or `firebase deploy --only storage` is a
    // no-op and the bucket keeps whatever rules it had - most likely none.
    assert.equal(firebaseConfig.storage.rules, "storage.rules");
    assert.equal(
      firebaseConfig.storage.bucket,
      "qcdao-a0c7a.firebasestorage.app",
      "deploy must target the same bucket the web app uses, not *.appspot.com",
    );
    assert.ok(fs.existsSync(new URL("../storage.rules", import.meta.url)));

    // Without this the uploader fails at runtime with an opaque CSP violation
    // rather than anything that points at the cause.
    const policy = contentSecurityPolicy();
    assert.ok(policy.includes("https://firebasestorage.googleapis.com"));
    assert.equal(policy.includes("https://*.googleapis.com"), false);
  });

  it("[BUT-OPD-021] keeps localhost and wildcards out of the production bucket CORS", () => {
    const cors = JSON.parse(
      fs.readFileSync(new URL("../storage.cors.json", import.meta.url), "utf8"),
    );
    const origins = cors.flatMap((entry) => entry.origin);

    assert.equal(origins.includes("*"), false, "wildcard origin on the production bucket");
    for (const origin of origins) {
      assert.equal(
        /localhost|127\.0\.0\.1|\[::1\]/.test(origin),
        false,
        `${origin} would let a page served from a developer machine read production objects; `
        + "local work uses the Storage emulator instead",
      );
      assert.match(origin, /^https:\/\//, `${origin} is not https`);
    }
  });

  it("[BUT-OPD-022] keeps attachments PDF-only and capped in the deployed rules", () => {
    const storageRules = fs.readFileSync(new URL("../storage.rules", import.meta.url), "utf8");
    assert.match(storageRules, /request\.resource\.contentType == 'application\/pdf'/);
    assert.match(storageRules, /return 10 \* 1024 \* 1024;/);
    // The catch-all must stay last, so a path nobody wrote a rule for is denied.
    assert.match(storageRules, /match \/\{allPaths=\*\*\} \{\s*allow read, write: if false;/);

    // Attachments are immutable. `resource == null` is what enforces that, not the
    // absence of an `update` rule - Storage classifies an overwrite as a create, so
    // dropping this clause silently reopens content-swap-after-review.
    assert.match(storageRules, /allow create: if resource == null/);
    assert.equal(/allow create, update:/.test(storageRules), false);
  });

  it("enables TTL cleanup for nonce and rate-limit documents", () => {
    const ttlGroups = indexes.fieldOverrides
      .filter((entry) => entry.fieldPath === "expiresAt" && entry.ttl === true)
      .map((entry) => entry.collectionGroup)
      .sort();
    assert.deepEqual(ttlGroups, ["siweNonces", "siweRateLimits"]);
  });
});
