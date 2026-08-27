import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { messageForFirebaseError, fieldForFirebaseError, OnboardingError } from "../../src/lib/errors.js";

describe("Unit Tests: Error Messages & Mapping", () => {
  it("should map suspension error correctly when message contains 'suspended'", () => {
    const error = {
      code: "functions/permission-denied",
      message: "This administrator account is suspended.",
    };
    assert.equal(
      messageForFirebaseError(error),
      "Your account has been suspended, contact an administrator.",
    );
  });

  it("should map functions/permission-denied to general permission notice when not suspended", () => {
    const error = {
      code: "functions/permission-denied",
      message: "Admin privileges required.",
    };
    assert.equal(
      messageForFirebaseError(error),
      "You do not have permission to perform this action. Administrator privileges may be required.",
    );
  });

  it("should map functions/internal to missing deployment notice", () => {
    const error = { code: "functions/internal" };
    assert.ok(messageForFirebaseError(error).includes("Could not reach the sign-in server"));
  });

  it("should map known auth errors correctly", () => {
    const error = { code: "auth/network-request-failed" };
    assert.equal(
      messageForFirebaseError(error),
      "We could not reach the authentication service. Check your internet connection and try again.",
    );
  });

  it("should map firestore permission-denied correctly", () => {
    const error = { code: "firestore/permission-denied" };
    assert.ok(messageForFirebaseError(error).includes("rejected by our security rules"));
  });

  it("should handle OnboardingError instance correctly", () => {
    const error = new OnboardingError("Name too short", { field: "fullName" });
    assert.equal(messageForFirebaseError(error), "Name too short");
    assert.equal(fieldForFirebaseError(error), "fullName");
  });

  it("should handle numeric error codes safely without throwing", () => {
    const error = { code: 4001, message: "User rejected" };
    const msg = messageForFirebaseError(error);
    assert.ok(typeof msg === "string");
  });
});
