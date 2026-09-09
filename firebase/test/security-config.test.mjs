import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { LOCAL_ORIGINS, localHostingConfig } from "../scripts/local-hosting-config.mjs";

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

  // The Hosting emulator serves these headers verbatim, so the local profile is
  // generated from this same file rather than hand-copied beside it.
  describe("local Hosting emulator config", () => {
    const local = localHostingConfig(firebaseConfig);
    const localPolicy = () => local.hosting.headers
      .flatMap((entry) => entry.headers)
      .find((header) => header.key === "Content-Security-Policy")?.value;

    it("never lets localhost reach the deployed policy", () => {
      // The whole point of generating the local config is that this stays true.
      const policy = contentSecurityPolicy();
      for (const origin of ["127.0.0.1", "localhost", "ws://"]) {
        assert.equal(policy.includes(origin), false, `production CSP trusts ${origin}`);
      }
      assert.ok(policy.includes("upgrade-insecure-requests"));
      assert.ok(firebaseConfig.hosting.headers
        .flatMap((entry) => entry.headers)
        .some((header) => header.key === "Strict-Transport-Security"));
    });

    it("reaches every emulator the app talks to", () => {
      const connectSrc = localPolicy().split(";").map((part) => part.trim())
        .find((directive) => directive.startsWith("connect-src "));
      for (const origin of LOCAL_ORIGINS) {
        assert.ok(connectSrc.includes(origin), `local CSP cannot reach ${origin}`);
      }
      // Firestore, Auth, Functions and Storage are all plain http on localhost.
      // Left in, this rewrites them to https and every call fails to connect.
      assert.equal(localPolicy().includes("upgrade-insecure-requests"), false);
      // HSTS on localhost outlives the emulator run and pins every later
      // http://localhost service in the same browser to https.
      assert.equal(local.hosting.headers
        .flatMap((entry) => entry.headers)
        .some((header) => header.key === "Strict-Transport-Security"), false);
    });

    it("changes nothing else, so the local profile cannot drift", () => {
      assert.deepEqual(local.hosting.rewrites, firebaseConfig.hosting.rewrites);
      assert.equal(local.hosting.public, firebaseConfig.hosting.public);
      assert.deepEqual(local.firestore, firebaseConfig.firestore);
      assert.deepEqual(local.storage, firebaseConfig.storage);
      assert.deepEqual(local.functions, firebaseConfig.functions);
      assert.deepEqual(local.emulators, firebaseConfig.emulators);
      // Same header set minus HSTS, and the deployed policy still allows what it did.
      assert.ok(localPolicy().includes("https://asia-southeast1-qcdao-a0c7a.cloudfunctions.net"));
      assert.equal(localPolicy().includes("*.googleapis.com"), false);
    });

    it("is generated, never committed, so it cannot be deployed", () => {
      const ignored = fs.readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");
      assert.match(ignored, /^firebase\/firebase\.local\.json$/m);
    });
  });

  it("deploys retried triggers the same way from CI and from a preview", () => {
    // Both triggers set `retry: true`, and the CLI refuses a failure policy
    // without --force. CI had it and preview-deploy did not, so the same commit
    // deployed from a laptop died on a gate CI never sees. Keeping the two in
    // step here is cheaper than rediscovering it mid-deploy.
    const workflow = fs.readFileSync(
      new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8",
    );
    const previewDeploy = fs.readFileSync(
      new URL("../scripts/preview-deploy.mjs", import.meta.url), "utf8",
    );
    const retried = [...functionsSource.matchAll(/export const (\w+) = onDocument\w+\(\s*\{[^\n]*retry:\s*true/g)]
      .map(([, name]) => name);
    assert.ok(retried.length > 0, "no retried trigger found; this guard is watching the wrong thing");
    assert.match(workflow, /--non-interactive --force/);
    assert.match(previewDeploy, /"--non-interactive", "--force"/);
  });

  it("keeps the audit trail trigger retried and idempotent", () => {
    // Retry is what stops a transient Firestore error silently losing an edit
    // from the record. It is only safe because the entry is keyed on the event
    // id, so a redelivery overwrites rather than appends a duplicate.
    assert.match(functionsSource, /recordProposalEdit = onDocumentUpdated\(\s*\{[^\n]*retry:\s*true/);
    assert.match(functionsSource, /recordOpportunityEdit = onDocumentUpdated\(\s*\{[^\n]*retry:\s*true/);
    const revisions = fs.readFileSync(
      new URL("../functions/proposalRevisions.js", import.meta.url), "utf8",
    );
    assert.match(revisions, /\.doc\(eventId\)/);
    const opportunityRevisions = fs.readFileSync(
      new URL("../functions/opportunityRevisions.js", import.meta.url), "utf8",
    );
    assert.match(opportunityRevisions, /\.doc\(eventId\)/);
  });

  it("enables TTL cleanup for nonce and rate-limit documents", () => {
    const ttlGroups = indexes.fieldOverrides
      .filter((entry) => entry.fieldPath === "expiresAt" && entry.ttl === true)
      .map((entry) => entry.collectionGroup)
      .sort();
    assert.deepEqual(ttlGroups, ["siweNonces", "siweRateLimits"]);
  });
});
