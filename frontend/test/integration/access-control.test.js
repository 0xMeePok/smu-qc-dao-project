import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "../../src/config/roles.js";
import { evaluateRouteAccess } from "../../src/config/routes.js";

describe("Integration Tests: Capability-Based Access Control & Route Guard Security", () => {
  // Test user fixtures independent of temporary demo objects
  const guestUser = null;
  const memberUser = {
    id: "usr_test_member",
    name: "Test Platform Member",
    roles: [ROLES.OWNER, ROLES.RESEARCHER, ROLES.EVALUATOR, ROLES.FUNDER],
  };
  const adminUser = {
    id: "usr_test_admin",
    name: "Test DAO Admin",
    roles: [ROLES.ADMIN],
  };

  it("[FIT-AAR-001] should grant unauthenticated guests access to all public routes", () => {
    const publicRoutes = ["home", "discover", "opportunity", "login", "access-denied"];

    for (const route of publicRoutes) {
      const decision = evaluateRouteAccess(route, guestUser);
      assert.equal(decision.status, 200, `Guest should access public route: ${route}`);
      assert.equal(decision.allowed, true);
      assert.equal(decision.action, "RENDER");
    }
  });

  it("[FIT-AAR-002] should redirect unauthenticated guests to login with return target when accessing protected routes", () => {
    const protectedRoutes = [
      "create",
      "my-problems",
      "proposals",
      "evaluations",
      "funding",
      "admin",
    ];

    for (const route of protectedRoutes) {
      const decision = evaluateRouteAccess(route, guestUser);
      assert.equal(
        decision.status,
        302,
        `Guest should be redirected when accessing protected route: ${route}`
      );
      assert.equal(decision.allowed, false);
      assert.equal(decision.action, "REDIRECT_LOGIN");
      assert.equal(decision.target, `login?redirect=${encodeURIComponent(route)}`);
    }
  });

  it("[FIT-AAR-003] should grant multi-role member access to Create Brief across publishing capacities", () => {
    const decision = evaluateRouteAccess("create", memberUser);
    assert.equal(decision.status, 200);
    assert.equal(decision.allowed, true);
    assert.equal(decision.action, "RENDER");

    // Member possesses owner, researcher, and funder capabilities needed for creating opportunities
    assert.ok(memberUser.roles.includes(ROLES.OWNER));
    assert.ok(memberUser.roles.includes(ROLES.RESEARCHER));
    assert.ok(memberUser.roles.includes(ROLES.FUNDER));
  });

  it("[FIT-AAR-004] should grant multi-role member access to all four participant workspaces without switching accounts", () => {
    const workspaces = ["my-problems", "proposals", "evaluations", "funding"];

    for (const ws of workspaces) {
      const decision = evaluateRouteAccess(ws, memberUser);
      assert.equal(
        decision.status,
        200,
        `Multi-role member should have access to workspace: ${ws}`
      );
      assert.equal(decision.allowed, true);
      assert.equal(decision.action, "RENDER");
    }
  });

  it("[FIT-AAR-005] should strictly bar multi-role member from DAO Admin Audit route with 403 Forbidden", () => {
    const decision = evaluateRouteAccess("admin", memberUser);
    assert.equal(decision.status, 403);
    assert.equal(decision.allowed, false);
    assert.equal(decision.action, "DENY_403");
  });

  it("[FIT-AAR-006] should grant DAO Admin access to Admin Audit console", () => {
    const decision = evaluateRouteAccess("admin", adminUser);
    assert.equal(decision.status, 200);
    assert.equal(decision.allowed, true);
    assert.equal(decision.action, "RENDER");
  });

  it("[FIT-AAR-007] should strictly bar DAO Admin from Create Brief and participant workspaces with 403 Forbidden", () => {
    const restrictedRoutes = [
      "create",
      "my-problems",
      "proposals",
      "evaluations",
      "funding",
    ];

    for (const route of restrictedRoutes) {
      const decision = evaluateRouteAccess(route, adminUser);
      assert.equal(
        decision.status,
        403,
        `DAO Admin must be forbidden from accessing: ${route}`
      );
      assert.equal(decision.allowed, false);
      assert.equal(decision.action, "DENY_403");
    }
  });
});
