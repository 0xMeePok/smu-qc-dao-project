import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  validateFullName,
  validateOnboarding,
  validateOrganisation,
  validateTerms,
  validateWallet,
} from "../src/lib/validation.js";
import { initialStats, statKeys, withDefaults } from "../src/lib/stats.js";
import { isAdmin, roleLabel, ROLE_ADMIN, ROLE_USER } from "../src/lib/roles.js";

const VALID_ADDRESS = `0x${"a".repeat(40)}`;

const validForm = {
  fullName: "Ashley Chung",
  organisation: "Singapore Management University",
  acceptedTerms: true,
};

describe("name and organisation", () => {
  it("rejects empty values", () => {
    assert.match(validateFullName(""), /Enter your full name/);
    assert.match(validateOrganisation("  "), /Enter the organisation/);
  });

  it("rejects single characters and over-long values", () => {
    assert.match(validateFullName("A"), /at least 2/);
    assert.match(validateOrganisation("x".repeat(121)), /longer than 120/);
    assert.match(validateFullName("x".repeat(81)), /longer than 80/);
  });

  it("accepts ordinary values and ignores surrounding whitespace", () => {
    assert.equal(validateFullName("  Ashley Chung  "), null);
    assert.equal(validateOrganisation("SMU"), null);
  });
});

describe("terms", () => {
  it("requires the terms to be accepted", () => {
    assert.match(validateTerms(false), /accept the platform terms/);
    assert.equal(validateTerms(true), null);
  });
});

describe("roles", () => {
  it("has exactly two levels: 0 (user) and 1 (administrator)", () => {
    assert.equal(ROLE_USER, 0);
    assert.equal(ROLE_ADMIN, 1);
  });

  it("only recognises the admin constant as an admin", () => {
    assert.equal(isAdmin(ROLE_ADMIN), true);
    assert.equal(isAdmin(ROLE_USER), false);
    assert.equal(isAdmin(undefined), false);
  });

  it("labels each level for display", () => {
    assert.equal(roleLabel(ROLE_ADMIN), "Administrator");
    assert.equal(roleLabel(ROLE_USER), "User");
  });
});

describe("wallet validation", () => {
  it("requires a verified address", () => {
    assert.match(validateWallet(null), /Connect and verify your wallet/);
  });

  it("rejects a malformed address", () => {
    assert.match(validateWallet("0xnope"), /not a valid Ethereum address/);
  });

  it("accepts a verified address", () => {
    assert.equal(validateWallet(VALID_ADDRESS), null);
  });

  // The signature itself is checked by firebase/functions/index.js before the client
  // ever holds a session, so there is nothing signature-shaped left to validate here.
  it("does not ask the client to vouch for a signature", () => {
    assert.equal(validateWallet(VALID_ADDRESS), null);
  });
});

describe("whole-form validation", () => {
  it("flags every field on an empty form with no wallet", () => {
    const errors = validateOnboarding(
      { fullName: "", organisation: "", acceptedTerms: false },
      null,
    );
    assert.deepEqual(Object.keys(errors).sort(), [
      "acceptedTerms", "fullName", "organisation", "wallet",
    ]);
  });

  it("returns no errors for a complete form with a signed wallet", () => {
    assert.deepEqual(validateOnboarding(validForm, VALID_ADDRESS), {});
  });

  it("still rejects a complete form with no verified address", () => {
    const errors = validateOnboarding(validForm, null);
    assert.deepEqual(Object.keys(errors), ["wallet"]);
  });

  it("collects no email, password or role fields - every account starts as a normal user and role is never a form field", () => {
    const errors = validateOnboarding(
      { fullName: "", organisation: "", acceptedTerms: false },
      null,
    );
    assert.equal("email" in errors, false);
    assert.equal("password" in errors, false);
    assert.equal("role" in errors, false);
  });
});

describe("contribution counters", () => {
  it("tracks the six documented counters", () => {
    assert.deepEqual(statKeys.sort(), [
      "businessProblems", "comments", "fundingRequests", "karma", "openFunding", "reputation",
    ]);
  });

  it("starts every counter at zero", () => {
    for (const key of statKeys) {
      assert.equal(initialStats[key], 0, `${key} should start at 0`);
    }
  });

  it("backfills counters missing from an older profile", () => {
    assert.deepEqual(withDefaults({ karma: 12 }), { ...initialStats, karma: 12 });
    assert.deepEqual(withDefaults(undefined), initialStats);
  });
});
