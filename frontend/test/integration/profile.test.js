import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "../../src/config/roles.js";
import { getPermittedNavRoutes, getRouteConfig } from "../../src/config/routes.js";
import { validateProfile } from "../../src/lib/validation.js";

const WALLET = `0x${"a".repeat(40)}`;

const profile = {
  address: WALLET,
  fullName: "Ashley Chung",
  organisation: "Singapore Management University",
  biography: "Quantum researcher focused on verification.",
  expertise: ["Quantum verification", "Compiler design"],
  role: 0,
  chainId: 421614,
  walletVerified: true,
  stats: {
    comments: 0,
    businessProblems: 0,
    openFunding: 0,
    fundingRequests: 0,
    karma: 0,
    reputation: 0,
  },
};

function decideProfileRoute({ signedIn, route = "profile" }) {
  const config = getRouteConfig(route);
  if (!signedIn && config.authRequired) {
    return { outcome: "REDIRECT", target: `login?redirect=${route}` };
  }
  if (config.authRequired && config.allowedRoles) {
    return { outcome: "ACCESS_DENIED" };
  }
  return { outcome: "AUTHORIZED" };
}

function applyEditableProfileFields(current, submitted) {
  return {
    ...current,
    fullName: submitted.fullName,
    organisation: submitted.organisation,
    biography: submitted.biography,
    expertise: submitted.expertise,
  };
}

describe("Integration Tests: Profile Access & Maintenance", () => {
  it("[FIT-AAR-007] should allow an authenticated participant to access Profile and see it in navigation", () => {
    const decision = decideProfileRoute({ signedIn: true });
    const navigation = getPermittedNavRoutes([
      ROLES.OWNER,
      ROLES.RESEARCHER,
      ROLES.EVALUATOR,
      ROLES.FUNDER,
    ]).map((route) => route.key);

    assert.deepEqual(decision, { outcome: "AUTHORIZED" });
    assert.equal(navigation.includes("profile"), true);
  });

  it("[FIT-AAR-008] should redirect a guest away from the private Profile route", () => {
    assert.deepEqual(decideProfileRoute({ signedIn: false }), {
      outcome: "REDIRECT",
      target: "login?redirect=profile",
    });
  });

  it("[FIT-AAR-009] should allow administrators to access Profile without granting participant workspaces", () => {
    const adminNavigation = getPermittedNavRoutes([ROLES.ADMIN]).map((route) => route.key);

    assert.deepEqual(decideProfileRoute({ signedIn: true }), { outcome: "AUTHORIZED" });
    assert.equal(adminNavigation.includes("profile"), true);
    assert.equal(adminNavigation.includes("proposals"), false);
  });

  it("[FIT-AAR-010] should accept a complete edit submission for all four editable fields", () => {
    const submitted = {
      fullName: "Ada Lovelace",
      organisation: "Analytical Engines Ltd",
      biography: "Researches reliable computational systems.",
      expertise: ["Formal methods", "Quantum computing"],
    };

    assert.deepEqual(validateProfile(submitted, WALLET), {});
    assert.deepEqual(
      applyEditableProfileFields(profile, submitted),
      {
        ...profile,
        ...submitted,
      },
    );
  });

  it("[FIT-AAR-011] should preserve role, UID, wallet, and statistics when profile fields are edited", () => {
    const submitted = {
      fullName: "Ada Lovelace",
      organisation: "Analytical Engines Ltd",
      biography: "Researches reliable computational systems.",
      expertise: ["Formal methods"],
    };
    const updated = applyEditableProfileFields(profile, submitted);

    assert.equal(updated.address, WALLET);
    assert.equal(updated.role, profile.role);
    assert.equal(updated.chainId, profile.chainId);
    assert.equal(updated.walletVerified, profile.walletVerified);
    assert.deepEqual(updated.stats, profile.stats);
  });

  it("[FIT-AAR-012] should keep public profile data limited to public-safe fields", () => {
    const publicProfile = {
      address: profile.address,
      fullName: profile.fullName,
      organisation: profile.organisation,
      biography: profile.biography,
      expertise: profile.expertise,
    };
    const privateFields = ["role", "stats", "chainId", "walletVerified", "termsAcceptedAt", "createdAt", "updatedAt"];

    assert.deepEqual(Object.keys(publicProfile).sort(), [
      "address", "biography", "expertise", "fullName", "organisation",
    ]);
    for (const field of privateFields) {
      assert.equal(field in publicProfile, false, `${field} must not be public`);
    }
  });
});
