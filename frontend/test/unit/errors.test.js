import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditErrorMessage, isModuleLoadError, isRpcQuotaExceeded, isRpcUnreachable, MODULE_LOAD_ERROR_MESSAGE, messageForFirebaseError, messageForPublicationSaveError, fieldForFirebaseError, OnboardingError, redactUrlPaths, RPC_QUOTA_MESSAGE, RPC_UNREACHABLE_MESSAGE } from "../../src/lib/errors.js";
import { messageForProposalError } from "../../src/lib/proposalValidation.js";
import { escrowErrorMessage } from "../../src/lib/escrow.js";

describe("publication errors stay separate from sign-in errors", () => {
  it("does not interpret a publication precondition as a missing sign-in nonce", () => {
    const error = { code: "functions/failed-precondition", message: "The content could not be verified against its mined transaction. Wait for confirmation and retry." };
    assert.match(messageForPublicationSaveError(error), /server could not verify this submission/);
    assert.doesNotMatch(messageForPublicationSaveError(error), /sign.in/);
    assert.match(messageForFirebaseError(error), /No sign-in request/);
  });
  for (const [message, expected] of [
    ["Registry maintenance or retirement prevents publication.", /maintenance/],
    ["An attachment reservation does not match the published file.", /attachment could not be verified/],
    ["An attachment was removed. Select it again.", /attachment was removed/],
  ]) it(`preserves actionable publication guidance: ${message}`, () => {
    assert.match(messageForPublicationSaveError({ code: "functions/failed-precondition", message }), expected);
  });
  it("maps only actual authentication failures to sign-in guidance", () => {
    assert.match(messageForPublicationSaveError({ code: "functions/unauthenticated" }), /session has expired/);
    assert.doesNotMatch(messageForPublicationSaveError({ code: "functions/internal" }), /sign.in|nonce/);
  });
});

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
    // Refreshing fixes a missing app file, not an RPC that will not answer, so
    // this says what actually went wrong instead.
    assert.equal(auditErrorMessage(error), RPC_UNREACHABLE_MESSAGE);
    assert.equal(messageForFirebaseError(error), RPC_UNREACHABLE_MESSAGE);
    assert.equal(messageForProposalError(error), RPC_UNREACHABLE_MESSAGE);
    for (const message of [auditErrorMessage(error), messageForProposalError(error)]) {
      assert.doesNotMatch(message, /draft or copy your edits|refresh the page/i);
    }
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

/**
 * The real message viem produced when the project's Alchemy plan ran out of
 * monthly capacity. The provider answered 429 without CORS headers, so the
 * browser reported only "Failed to fetch" and viem wrapped the whole request -
 * RPC URL and API key included - into the message shown on the submit banner.
 */
const TRANSPORT_FAILURE = Object.assign(
  new Error([
    "HTTP request failed.",
    "URL: https://arb-sepolia.g.alchemy.com/v2/alch_TESTKEY0000000000000000",
    'Request body: {"method":"eth_call","params":[{"to":"0xca11bde05977b3631167028862be2a173976ca11","data":"0x82ad56cb"}]}',
    "Raw Call Arguments:",
    "  to:    0x38BEc81577C0EA78B003F12c6CeBB16896999187",
    "  data:  0x475d20ac8077982238e31519f3016fa85035cbd0",
    "Contract Call:",
    "  function:  opportunityRevisionCount(bytes32 opportunityId)",
    "Docs: https://viem.sh/docs/contract/readContract",
    "Details: Failed to fetch",
    "Version: viem@2.55.19",
  ].join("\n")),
  { name: "HttpRequestError", details: "Failed to fetch" },
);

describe("an RPC provider that cannot be reached", () => {
  it("names the real problem instead of a revert that never happened", () => {
    assert.equal(isRpcUnreachable(TRANSPORT_FAILURE), true);
    assert.equal(auditErrorMessage(TRANSPORT_FAILURE), RPC_UNREACHABLE_MESSAGE);
    assert.equal(messageForFirebaseError(TRANSPORT_FAILURE), RPC_UNREACHABLE_MESSAGE);
  });

  it("never prints the RPC URL or its API key on any error banner", () => {
    for (const message of [auditErrorMessage(TRANSPORT_FAILURE), messageForFirebaseError(TRANSPORT_FAILURE),
      messageForProposalError(TRANSPORT_FAILURE), escrowErrorMessage(TRANSPORT_FAILURE)]) {
      assert.doesNotMatch(message, /alch_TESTKEY|\/v2\/|https?:\/\//);
    }
  });

  it("says nothing was submitted, because nothing was", () => {
    assert.match(RPC_UNREACHABLE_MESSAGE, /Nothing was submitted/);
    assert.match(RPC_QUOTA_MESSAGE, /Nothing was submitted/);
  });

  it("is not mistaken for a missing app file after a deployment", () => {
    const moduleFailure = { message: "Failed to fetch dynamically imported module: /assets/ccip-old.js" };
    assert.equal(isRpcUnreachable(moduleFailure), false);
    assert.equal(auditErrorMessage(moduleFailure), MODULE_LOAD_ERROR_MESSAGE);
  });

  it("still reports a genuine revert as a revert", () => {
    const reverted = new Error("execution reverted: InvalidInput");
    assert.equal(isRpcUnreachable(reverted), false);
    assert.match(auditErrorMessage(reverted), /transaction reverted/);
  });
});

describe("an RPC provider that is answering and refusing", () => {
  for (const error of [
    { message: "Monthly capacity limit exceeded. Visit https://dashboard.alchemy.com/settings/billing to upgrade." },
    { message: "request failed", cause: { status: 429, message: "Too Many Requests" } },
    { name: "RpcRequestError", message: "rate limit exceeded", code: -32005 },
  ]) {
    it(`reports a quota refusal as a quota refusal: ${String(error.message).slice(0, 32)}`, () => {
      assert.equal(isRpcQuotaExceeded(error), true);
      assert.equal(auditErrorMessage(error), RPC_QUOTA_MESSAGE);
      assert.doesNotMatch(auditErrorMessage(error), /https?:\/\//);
    });
  }
});

describe("URL redaction", () => {
  it("keeps the host and drops the path that carries the key", () => {
    assert.equal(
      redactUrlPaths("URL: https://arb-sepolia.g.alchemy.com/v2/alch_TESTKEY0000000000000000"),
      "URL: https://arb-sepolia.g.alchemy.com",
    );
  });

  it("leaves text with no URL in it alone", () => {
    assert.equal(redactUrlPaths("The verification transaction reverted."), "The verification transaction reverted.");
  });
});
