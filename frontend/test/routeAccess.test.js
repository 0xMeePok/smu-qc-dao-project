import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADMIN, AUTHENTICATED, PUBLIC, accessFor, allows, canAccess, landingFor } from "../src/lib/routeAccess.js";
import { ROLE_ADMIN, ROLE_USER } from "../src/lib/roles.js";

describe("route access levels", () => {
  it("treats unlisted routes as public", () => {
    assert.equal(accessFor("home"), PUBLIC);
    assert.equal(accessFor("discover"), PUBLIC);
    assert.equal(accessFor("create"), PUBLIC);
  });

  it("marks the admin route as admin-only", () => {
    assert.equal(accessFor("admin"), ADMIN);
  });

  it("decides on the first segment, so detail pages inherit their section", () => {
    assert.equal(accessFor("opportunity/qft-benchmark"), PUBLIC);
    assert.equal(accessFor("admin/users"), ADMIN);
  });

  it("fails open to public for junk input rather than locking a route", () => {
    assert.equal(accessFor(""), PUBLIC);
    assert.equal(accessFor(undefined), PUBLIC);
    assert.equal(accessFor(null), PUBLIC);
  });
});

describe("canAccess", () => {
  it("lets anyone into a public route, signed in or not", () => {
    assert.equal(canAccess("home", { isSignedIn: false }), true);
    assert.equal(canAccess("home", { isSignedIn: true, role: ROLE_USER }), true);
  });

  it("keeps a signed-out visitor out of the admin route", () => {
    assert.equal(canAccess("admin", { isSignedIn: false }), false);
  });

  it("keeps a signed-in ordinary user out of the admin route", () => {
    assert.equal(canAccess("admin", { isSignedIn: true, role: ROLE_USER }), false);
  });

  it("lets a signed-in administrator into the admin route", () => {
    assert.equal(canAccess("admin", { isSignedIn: true, role: ROLE_ADMIN }), true);
  });

  it("does not treat a missing role as an admin", () => {
    assert.equal(canAccess("admin", { isSignedIn: true }), false);
    assert.equal(canAccess("admin", { isSignedIn: true, role: undefined }), false);
    assert.equal(canAccess("admin", { isSignedIn: true, role: null }), false);
  });

  it("is not fooled by a truthy non-admin role value", () => {
    // isAdmin() compares against the exact constant - a client that forces
    // role: true or role: "1" into memory must not clear an admin gate.
    assert.equal(canAccess("admin", { isSignedIn: true, role: true }), false);
    assert.equal(canAccess("admin", { isSignedIn: true, role: "1" }), false);
    assert.equal(canAccess("admin", { isSignedIn: true, role: 2 }), false);
  });

  it("defaults to signed-out when given no session at all", () => {
    assert.equal(canAccess("admin"), false);
    assert.equal(canAccess("home"), true);
  });

  // The AUTHENTICATED level is implemented and exported but no route uses it yet,
  // so nothing above exercises the "signed in, any role" branch. Mutation testing
  // caught that: deleting the `if (!isSignedIn) return false;` line broke nothing,
  // because every ADMIN check independently fails on isAdmin(undefined). An
  // AUTHENTICATED route would have been wide open to signed-out visitors and no
  // test would have said a word. Sprints 2-6 add role-gated screens, so this branch
  // gets covered before something depends on it.
  describe("authenticated-only routes (level exists, no route uses it yet)", () => {
    // Calls the REAL allows() - the same function canAccess() delegates to in
    // production. An earlier draft of this block reimplemented the rules inside the
    // test, which would have kept passing no matter how badly the real code broke.
    it("is a distinct level from public and admin", () => {
      assert.equal(AUTHENTICATED, "authenticated");
      assert.notEqual(AUTHENTICATED, PUBLIC);
      assert.notEqual(AUTHENTICATED, ADMIN);
    });

    it("admits any signed-in user regardless of role", () => {
      assert.equal(allows(AUTHENTICATED, { isSignedIn: true, role: ROLE_USER }), true);
      assert.equal(allows(AUTHENTICATED, { isSignedIn: true, role: ROLE_ADMIN }), true);
    });

    it("refuses a signed-out visitor", () => {
      assert.equal(allows(AUTHENTICATED, { isSignedIn: false }), false);
      assert.equal(allows(AUTHENTICATED, {}), false);
    });

    it("still gates admin and opens public through the same function", () => {
      assert.equal(allows(ADMIN, { isSignedIn: true, role: ROLE_USER }), false);
      assert.equal(allows(ADMIN, { isSignedIn: true, role: ROLE_ADMIN }), true);
      assert.equal(allows(PUBLIC, { isSignedIn: false }), true);
    });
  });
});

describe("post-login landing", () => {
  it("sends an administrator to the admin screen", () => {
    assert.equal(landingFor(ROLE_ADMIN), "admin");
  });

  it("sends an ordinary user home", () => {
    assert.equal(landingFor(ROLE_USER), "home");
  });

  it("sends an unknown role home rather than to the admin screen", () => {
    assert.equal(landingFor(undefined), "home");
  });
});
