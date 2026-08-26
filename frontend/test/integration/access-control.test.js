import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "../../src/config/roles.js";
import { getRouteConfig } from "../../src/config/routes.js";

/**
 * Access Control Decision Evaluator
 * Models the runtime evaluation performed by RouteGuard & AuthContext
 */
function evaluateAccess(routeKey, user) {
  const routeConfig = getRouteConfig(routeKey);
  if (!routeConfig) {
    return { status: 404, allowed: false, action: "NOT_FOUND" };
  }

  // 1. Public route check
  if (!routeConfig.authRequired) {
    return { status: 200, allowed: true, action: "RENDER" };
  }

  // 2. Authentication check
  if (!user || !user.roles || user.roles.length === 0 || (user.roles.length === 1 && user.roles[0] === ROLES.GUEST)) {
    return {
      status: 302,
      allowed: false,
      action: "REDIRECT_LOGIN",
      target: `login?redirect=${encodeURIComponent(routeKey)}`,
    };
  }

  // 3. Multi-role capability / set intersection check
  const hasCapability = user.roles.some((role) =>
    routeConfig.allowedRoles?.includes(role)
  );

  if (hasCapability) {
    return { status: 200, allowed: true, action: "RENDER" };
  }

  // 4. Unauthorized role
  return { status: 403, allowed: false, action: "DENY_403" };
}

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
      const decision = evaluateAccess(route, guestUser);
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
      const decision = evaluateAccess(route, guestUser);
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
    const decision = evaluateAccess("create", memberUser);
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
      const decision = evaluateAccess(ws, memberUser);
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
    const decision = evaluateAccess("admin", memberUser);
    assert.equal(decision.status, 403);
    assert.equal(decision.allowed, false);
    assert.equal(decision.action, "DENY_403");
  });

  it("[FIT-AAR-006] should grant DAO Admin access to Admin Audit console", () => {
    const decision = evaluateAccess("admin", adminUser);
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
      const decision = evaluateAccess(route, adminUser);
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
