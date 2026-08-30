import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDomain } from "../siweOrigin.js";

function requestWithOrigin(origin) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  return { rawRequest: { headers } };
}

const production = {
  FUNCTIONS_EMULATOR: "false",
  GCLOUD_PROJECT: "qc-dao-demo",
};

const productionWithPreview = {
  ...production,
  SIWE_ALLOWED_HOSTS: "qc-dao-demo--test-cd-wm5z6dh8.web.app",
};

function assertPermissionDenied(fn) {
  assert.throws(fn, (error) => error.code === "permission-denied");
}

describe("QCDAO-126 production origin policy", () => {
  it("rejects missing Origin outside the emulator", () => {
    assertPermissionDenied(() => resolveDomain(requestWithOrigin(undefined), production));
  });

  it("rejects localhost in production", () => {
    assertPermissionDenied(
      () => resolveDomain(requestWithOrigin("http://localhost:5173"), production),
    );
  });
});

describe("QCDAO-121 preview hosts", () => {
  it("rejects a preview-shaped host that is not on SIWE_ALLOWED_HOSTS", () => {
    for (const host of [
      "qc-dao-demo--login-abcdefgh.web.app",
      "qc-dao-demo--evil.web.app",
      "qc-dao-demo--login-abc.web.app",
    ]) {
      assertPermissionDenied(
        () => resolveDomain(requestWithOrigin(`https://${host}`), production),
      );
    }
  });

  it("rejects a preview-shaped host from another Firebase project", () => {
    assertPermissionDenied(
      () => resolveDomain(
        requestWithOrigin("https://some-other-project--pr-1-aaaa.web.app"),
        productionWithPreview,
      ),
    );
  });

  it("accepts a preview host only when it is on SIWE_ALLOWED_HOSTS", () => {
    const allowed = "qc-dao-demo--test-cd-wm5z6dh8.web.app";
    assert.equal(
      resolveDomain(requestWithOrigin(`https://${allowed}`), productionWithPreview),
      allowed,
    );
    assertPermissionDenied(
      () => resolveDomain(requestWithOrigin(`https://${allowed}`), production),
    );
  });

  it("accepts the project's live hosting domains without extra config", () => {
    assert.equal(
      resolveDomain(requestWithOrigin("https://qc-dao-demo.web.app"), production),
      "qc-dao-demo.web.app",
    );
    assert.equal(
      resolveDomain(requestWithOrigin("https://qc-dao-demo.firebaseapp.com"), production),
      "qc-dao-demo.firebaseapp.com",
    );
  });
});
