import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "../../src/config/roles.js";
import {
  ROUTES_CONFIG,
  getRouteConfig,
  getPermittedNavRoutes,
} from "../../src/config/routes.js";

describe("Unit Tests: Route Configurations & Navigation Filtering", () => {
  it("[FUT-AAR-005] should retrieve exact route configuration via getRouteConfig", () => {
    const homeConfig = getRouteConfig("home");
    assert.ok(homeConfig);
    assert.equal(homeConfig.label, "Home");
    assert.equal(homeConfig.authRequired, false);

    const adminConfig = getRouteConfig("admin");
    assert.ok(adminConfig);
    assert.equal(adminConfig.label, "Admin Audit");
    assert.equal(adminConfig.authRequired, true);
    assert.deepEqual(adminConfig.allowedRoles, [ROLES.ADMIN]);

    const createConfig = getRouteConfig("create");
    assert.ok(createConfig);
    assert.equal(createConfig.label, "Create Brief");
    assert.equal(createConfig.authRequired, true);
    assert.deepEqual(createConfig.allowedRoles, [
      ROLES.OWNER,
      ROLES.RESEARCHER,
      ROLES.FUNDER,
    ]);
  });

  it("[FUT-AAR-006] should maintain correct public and protected flags across all routes", () => {
    const expectedPublicKeys = ["home", "discover", "opportunity", "login", "access-denied"];
    const expectedProtectedKeys = [
      "create",
      "my-problems",
      "proposals",
      "evaluations",
      "funding",
      "admin",
    ];

    for (const key of expectedPublicKeys) {
      const config = getRouteConfig(key);
      assert.ok(config, `Route ${key} must exist in ROUTES_CONFIG`);
      assert.equal(config.authRequired, false, `Route ${key} must not require auth`);
      assert.equal(config.allowedRoles, null);
    }

    for (const key of expectedProtectedKeys) {
      const config = getRouteConfig(key);
      assert.ok(config, `Route ${key} must exist in ROUTES_CONFIG`);
      assert.equal(config.authRequired, true, `Route ${key} must require auth`);
      assert.ok(
        Array.isArray(config.allowedRoles) && config.allowedRoles.length > 0,
        `Route ${key} must specify allowedRoles array`
      );
    }
  });

  it("[FUT-AAR-007] should filter navigation routes for unauthenticated guests to only public items", () => {
    const guestNav = getPermittedNavRoutes([]);
    const guestNavKeys = guestNav.map((r) => r.key);

    assert.deepEqual(guestNavKeys, ["home", "discover"]);
    assert.ok(!guestNavKeys.includes("create"));
    assert.ok(!guestNavKeys.includes("my-problems"));
    assert.ok(!guestNavKeys.includes("admin"));
  });

  it("[FUT-AAR-008] should filter navigation routes for multi-role members to include all 4 workspaces and Create Brief", () => {
    const memberRoles = [
      ROLES.OWNER,
      ROLES.RESEARCHER,
      ROLES.EVALUATOR,
      ROLES.FUNDER,
    ];
    const memberNav = getPermittedNavRoutes(memberRoles);
    const memberNavKeys = memberNav.map((r) => r.key);

    assert.ok(memberNavKeys.includes("home"));
    assert.ok(memberNavKeys.includes("discover"));
    assert.ok(memberNavKeys.includes("create"));
    assert.ok(memberNavKeys.includes("my-problems"));
    assert.ok(memberNavKeys.includes("proposals"));
    assert.ok(memberNavKeys.includes("evaluations"));
    assert.ok(memberNavKeys.includes("funding"));
    assert.ok(
      !memberNavKeys.includes("admin"),
      "Multi-role member nav must NOT include admin route"
    );
  });

  it("[FUT-AAR-009] should filter navigation routes for DAO Admin to include Admin Audit while excluding member workspaces", () => {
    const adminNav = getPermittedNavRoutes([ROLES.ADMIN]);
    const adminNavKeys = adminNav.map((r) => r.key);

    assert.ok(adminNavKeys.includes("home"));
    assert.ok(adminNavKeys.includes("discover"));
    assert.ok(adminNavKeys.includes("admin"));

    assert.ok(!adminNavKeys.includes("create"));
    assert.ok(!adminNavKeys.includes("my-problems"));
    assert.ok(!adminNavKeys.includes("proposals"));
    assert.ok(!adminNavKeys.includes("evaluations"));
    assert.ok(!adminNavKeys.includes("funding"));
  });

  it("[FUT-AAR-010] should return undefined from getRouteConfig for unknown route paths", () => {
    const invalidConfig = getRouteConfig("non-existent-route-key");
    assert.equal(invalidConfig, undefined);

    const demoConfig = getRouteConfig("demo");
    assert.equal(demoConfig, undefined);

    const emptyConfig = getRouteConfig("");
    assert.equal(emptyConfig, undefined);
  });
});
