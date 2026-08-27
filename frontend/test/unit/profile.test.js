import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "../../src/config/roles.js";
import { getPermittedNavRoutes, getRouteConfig } from "../../src/config/routes.js";
import {
  validateBiography,
  validateExpertise,
  validateProfile,
} from "../../src/lib/validation.js";

const VALID_ADDRESS = `0x${"a".repeat(40)}`;

const validProfile = {
  fullName: "Ashley Chung",
  organisation: "Singapore Management University",
  biography: "Quantum researcher focused on verification.",
  expertise: ["Quantum verification", "Compiler design"],
};

describe("Unit Tests: Profile Route & Navigation", () => {
  it("[FUT-AAR-074] should protect the private profile route for authenticated users", () => {
    const profileConfig = getRouteConfig("profile");

    assert.ok(profileConfig);
    assert.equal(profileConfig.path, "profile");
    assert.equal(profileConfig.authRequired, true);
    assert.equal(profileConfig.allowedRoles, null);
  });

  it("[FUT-AAR-075] should hide Profile from guests and show it to every participant role", () => {
    const guestRoutes = getPermittedNavRoutes([]).map((route) => route.key);
    assert.equal(guestRoutes.includes("profile"), false);

    const participantRoutes = getPermittedNavRoutes([
      ROLES.OWNER,
      ROLES.RESEARCHER,
      ROLES.EVALUATOR,
      ROLES.FUNDER,
    ]).map((route) => route.key);
    assert.equal(participantRoutes.includes("profile"), true);
  });

  it("[FUT-AAR-076] should keep Profile available to administrators", () => {
    const adminRoutes = getPermittedNavRoutes([ROLES.ADMIN]).map((route) => route.key);
    assert.equal(adminRoutes.includes("profile"), true);
  });
});

describe("Unit Tests: Profile Field Validation", () => {
  it("[FUT-AAR-077] should accept all four editable profile fields", () => {
    assert.deepEqual(validateProfile(validProfile, VALID_ADDRESS), {});
  });

  it("[FUT-AAR-078] should require a valid name, organisation, and wallet", () => {
    const errors = validateProfile({
      fullName: "",
      organisation: "",
      biography: "",
      expertise: [],
    }, null);

    assert.deepEqual(Object.keys(errors).sort(), ["fullName", "organisation", "wallet"]);
  });

  it("[FUT-AAR-079] should allow an empty biography but reject more than 500 characters", () => {
    assert.equal(validateBiography(""), null);
    assert.match(validateBiography("x".repeat(501)), /longer than 500/);
  });

  it("[FUT-AAR-080] should allow up to 12 expertise areas", () => {
    assert.equal(validateExpertise(Array.from({ length: 12 }, () => "Quantum science")), null);
    assert.match(
      validateExpertise(Array.from({ length: 13 }, () => "Quantum science")),
      /no more than 12/,
    );
  });

  it("[FUT-AAR-081] should reject expertise entries that are too short or too long", () => {
    assert.match(validateExpertise(["x"]), /at least 2/);
    assert.match(validateExpertise(["x".repeat(81)]), /longer than 80/);
  });

  it("[FUT-AAR-082] should require expertise to be an array of text values", () => {
    assert.match(validateExpertise("Quantum science"), /must be a list/);
    assert.match(validateExpertise(["Quantum science", 42]), /at least 2/);
  });

  it("[FUT-AAR-083] should not require read-only role, UID, or terms fields for profile edits", () => {
    assert.deepEqual(validateProfile({
      ...validProfile,
      role: 1,
      uid: VALID_ADDRESS,
      acceptedTerms: false,
    }, VALID_ADDRESS), {});
  });
});
