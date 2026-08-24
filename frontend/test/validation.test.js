import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  validateFullName,
  validateOnboarding,
  validateOrganisation,
  validateRole,
  validateTerms,
  validateWallet,
} from "../src/lib/validation.js";
import { initialStats, statKeys, withDefaults } from "../src/lib/stats.js";
import { DEFAULT_ROLE, roleValues } from "../src/lib/roles.js";

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

describe("role and terms", () => {
  it("rejects a role outside the five stakeholders", () => {
    assert.match(validateRole("hacker"), /not one of the available options/);
    assert.match(validateRole(""), /Choose the role/);
  });

  it("accepts each of the five roles", () => {
    for (const role of ["problem-owner", "funder", "researcher", "evaluator", "observer"]) {
      assert.equal(validateRole(role), null, `${role} should be accepted`);
    }
  });

  it("has a default role that is itself one of the five valid roles", () => {
    // The account is created with this before the user has visited the role-selection
    // screen, so it must pass the same validation as a real, deliberate choice.
    assert.ok(roleValues.includes(DEFAULT_ROLE));
    assert.equal(validateRole(DEFAULT_ROLE), null);
  });

  it("requires the terms to be accepted", () => {
    assert.match(validateTerms(false), /accept the platform terms/);
    assert.equal(validateTerms(true), null);
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

  it("collects no email, password or role fields - role is chosen once, on the role-selection screen", () => {
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
