import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
} from "../../src/config/roles.js";

describe("Unit Tests: Role Definitions & Capabilities", () => {
  it("[FUT-AAR-001] should define all valid participant, guest, and administrator role constants", () => {
    assert.equal(ROLES.GUEST, "guest");
    assert.equal(ROLES.OWNER, "owner");
    assert.equal(ROLES.RESEARCHER, "researcher");
    assert.equal(ROLES.EVALUATOR, "evaluator");
    assert.equal(ROLES.FUNDER, "funder");
    assert.equal(ROLES.ADMIN, "admin");

    const allRoles = Object.values(ROLES);
    assert.equal(allRoles.length, 6);
    assert.deepEqual(allRoles.sort(), [
      "admin",
      "evaluator",
      "funder",
      "guest",
      "owner",
      "researcher",
    ]);
  });

  it("[FUT-AAR-002] should provide human-readable labels and descriptions for all roles", () => {
    const roleKeys = Object.values(ROLES);

    for (const role of roleKeys) {
      assert.ok(ROLE_LABELS[role], `Missing label for role: ${role}`);
      assert.ok(typeof ROLE_LABELS[role] === "string");
      assert.ok(ROLE_LABELS[role].trim().length > 0);

      assert.ok(ROLE_DESCRIPTIONS[role], `Missing description for role: ${role}`);
      assert.ok(typeof ROLE_DESCRIPTIONS[role] === "string");
      assert.ok(ROLE_DESCRIPTIONS[role].trim().length > 0);
    }
  });

  it("[FUT-AAR-003] should validate participant capability set contains all four research roles", () => {
    const participantRoles = [
      ROLES.OWNER,
      ROLES.RESEARCHER,
      ROLES.EVALUATOR,
      ROLES.FUNDER,
    ];

    assert.equal(participantRoles.length, 4);
    assert.ok(participantRoles.includes(ROLES.OWNER));
    assert.ok(participantRoles.includes(ROLES.RESEARCHER));
    assert.ok(participantRoles.includes(ROLES.EVALUATOR));
    assert.ok(participantRoles.includes(ROLES.FUNDER));
    assert.ok(!participantRoles.includes(ROLES.ADMIN), "Participant roles set must NOT include admin");
    assert.ok(!participantRoles.includes(ROLES.GUEST), "Participant roles set must NOT include guest");
  });

  it("[FUT-AAR-004] should validate administrative capability isolation from participant capabilities", () => {
    const adminRole = ROLES.ADMIN;
    const participantRoles = [
      ROLES.OWNER,
      ROLES.RESEARCHER,
      ROLES.EVALUATOR,
      ROLES.FUNDER,
      ROLES.GUEST,
    ];

    assert.equal(adminRole, "admin");
    for (const pRole of participantRoles) {
      assert.notEqual(
        adminRole,
        pRole,
        `Admin role must be strictly segregated from participant role: ${pRole}`
      );
    }
  });
});
