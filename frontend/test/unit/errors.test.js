import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditErrorMessage, isModuleLoadError, MODULE_LOAD_ERROR_MESSAGE, messageForFirebaseError, fieldForFirebaseError, OnboardingError } from "../../src/lib/errors.js";
import { messageForProposalError } from "../../src/lib/proposalValidation.js";

describe("App files missing after a deployment", () => {
  for (const message of [
    "Failed to fetch dynamically imported module: https://example.test/assets/ccip-old.js",
    "error loading dynamically imported module: https://example.test/assets/ccip-old.js",
    "Importing a module script failed.",
    "Loading chunk wallet_123 failed.",
  ]) {
    it(`explains ${message.split(":")[0]} without exposing the contract wrapper`, () => {
      const error = {
        name: "ContractFunctionExecutionError",
        message: "opportunityRevisionCount reverted: InvalidInput",
        cause: { data: { originalError: new TypeError(message) } },
      };
      assert.equal(isModuleLoadError(error), true);
      assert.equal(auditErrorMessage(error), MODULE_LOAD_ERROR_MESSAGE);
      assert.equal(messageForFirebaseError(error), MODULE_LOAD_ERROR_MESSAGE);
      assert.equal(messageForProposalError(error), MODULE_LOAD_ERROR_MESSAGE);
      assert.match(auditErrorMessage(error), /Save your work as a draft or copy your edits, then refresh/);
    });
  }

  it("recognizes module loading errors carried in viem details or an error name", () => {
    for (const error of [
      { message: "An unknown error occurred", details: "Failed to fetch dynamically imported module: /assets/ccip-old.js" },
      { name: "ChunkLoadError", message: "A required resource failed" },
    ]) {
      assert.equal(auditErrorMessage(error), MODULE_LOAD_ERROR_MESSAGE);
    }
  });

  it("does not turn an ordinary RPC fetch failure into refresh instructions", () => {
    const error = new TypeError("Failed to fetch");
    error.cause = { message: "HTTP request failed: Arbitrum RPC unavailable" };
    assert.equal(isModuleLoadError(error), false);
    assert.equal(auditErrorMessage(error), "Failed to fetch");
    assert.equal(messageForFirebaseError(error), "Something went wrong: Failed to fetch");
    assert.equal(messageForProposalError(error), "Failed to fetch");
  });

  it("handles cyclic wrappers without losing a module failure in another branch", () => {
    const error = { message: "RPC request failed" };
    error.cause = error;
    assert.equal(isModuleLoadError(error), false);
    error.data = { originalError: { message: "Importing a module script failed.", cause: error } };
    assert.equal(auditErrorMessage(error), MODULE_LOAD_ERROR_MESSAGE);
  });
});

describe("Unit Tests: Error Messages & Mapping", () => {
  it("explains a base-fee rejection even when wrapped as a contract revert", () => {
    const error = { name: "ContractFunctionRevertedError", message: "commitOpportunity reverted",
      cause: { message: "max fee per gas less than block base fee: maxFeePerGas: 211272000 baseFee: 212608000" } };
    assert.match(messageForFirebaseError(error), /Network fees rose.*fresh fee estimate/);
  });
  it("surfaces retryable session revocation failures without a misleading success", () => {
    const message = messageForFirebaseError({
      code: "functions/unavailable",
      message: "Server credential revocation is pending. Retry sign out.",
    });
    assert.equal(message, "Server credential revocation is pending. Retry sign out.");
  });
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
