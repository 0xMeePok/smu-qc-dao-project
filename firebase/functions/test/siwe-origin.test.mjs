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
