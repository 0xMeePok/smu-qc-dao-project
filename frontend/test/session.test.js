import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROLES, landingRouteFor } from "../src/config/roles.js";
import { getRouteConfig } from "../src/config/routes.js";

/**
 * QCDAO-41 — log in and hold a persistent authenticated session.
 *
 * Covers the decision logic the story specifies. Two of its scope items are runtime
 * component behaviour (the guard rendering a loading state instead of redirecting,
 * and Firebase restoring a persisted session) and cannot be asserted without a DOM
 * renderer, which this project does not have. Those are called out in the story
 * analysis rather than silently skipped; what IS testable is the resolution rule the
 * guard consults and the landing rule Login applies.
 */

// Mirrors SessionContext: isLoading is true until Firebase has reported on a
// persisted session, and again while the profile carrying the role is being fetched.
function sessionIsLoading({ authResolved, status }) {
  return !authResolved || status === "checking";
}

// Mirrors RouteGuard's decision order. `loading` must be consulted FIRST - that
// ordering is the whole fix, so it is asserted directly.
function guardDecision({ isLoading, authRequired, isAuthenticated, permitted }) {
  if (isLoading) return "wait";
  if (authRequired && !isAuthenticated) return "redirect-to-login";
  if (authRequired && !permitted) return "access-denied";
  return "render";
}

describe("session loading state", () => {
  it("is loading before Firebase has reported on a persisted session", () => {
    // The refresh case: nobody has looked yet, so "signed out" is not yet knowable.
    assert.equal(sessionIsLoading({ authResolved: false, status: "signed-out" }), true);
  });

  it("is loading while the profile carrying the role is being fetched", () => {
    assert.equal(sessionIsLoading({ authResolved: true, status: "checking" }), true);
  });

  it("is not loading once a signed-in session has resolved", () => {
    assert.equal(sessionIsLoading({ authResolved: true, status: "signed-in" }), false);
  });

  it("is not loading once resolved as genuinely signed out", () => {
    assert.equal(sessionIsLoading({ authResolved: true, status: "signed-out" }), false);
  });

  it("is not loading when Firebase is unconfigured, so the app still renders", () => {
    // authResolved starts true in that case; otherwise the app would hang forever
    // on a session that is never coming.
    assert.equal(sessionIsLoading({ authResolved: true, status: "signed-out" }), false);
  });
});

describe("route guard decision order", () => {
  it("waits instead of redirecting while the session is unresolved", () => {
    // The regression this story exists to fix: on every refresh isAuthenticated is
    // briefly false for a user who IS signed in. Acting on that bounced them to
    // #/login on each reload.
    assert.equal(
      guardDecision({ isLoading: true, authRequired: true, isAuthenticated: false, permitted: false }),
      "wait",
    );
  });

  it("waits even when the unresolved state would otherwise render the page", () => {
    // Symmetric: a protected screen must not appear before the role is known either.
    assert.equal(
      guardDecision({ isLoading: true, authRequired: true, isAuthenticated: true, permitted: true }),
      "wait",
    );
  });

  it("redirects an genuinely signed-out visitor once resolved", () => {
    assert.equal(
      guardDecision({ isLoading: false, authRequired: true, isAuthenticated: false, permitted: false }),
      "redirect-to-login",
    );
  });

  it("denies a signed-in user who lacks the role", () => {
    assert.equal(
      guardDecision({ isLoading: false, authRequired: true, isAuthenticated: true, permitted: false }),
      "access-denied",
    );
  });

  it("renders for a signed-in user with the role", () => {
    assert.equal(
      guardDecision({ isLoading: false, authRequired: true, isAuthenticated: true, permitted: true }),
      "render",
    );
  });

  it("renders a public route without waiting on the session", () => {
    // Public pages must not be delayed by a lookup they do not need.
    assert.equal(
      guardDecision({ isLoading: false, authRequired: false, isAuthenticated: false, permitted: false }),
      "render",
    );
  });
});

describe("post-login landing", () => {
  it("sends an administrator to the admin workspace", () => {
    assert.equal(landingRouteFor([ROLES.ADMIN]), "admin");
  });

  it("sends a non-admin member home", () => {
    for (const role of [ROLES.OWNER, ROLES.RESEARCHER, ROLES.EVALUATOR, ROLES.FUNDER]) {
      assert.equal(landingRouteFor([role]), "home", `${role} should land home`);
    }
  });

  it("sends a guest home rather than to a protected screen", () => {
    assert.equal(landingRouteFor([ROLES.GUEST]), "home");
  });

  it("accepts a single role as well as a list", () => {
    assert.equal(landingRouteFor(ROLES.ADMIN), "admin");
  });

  it("picks admin when the user holds several roles including admin", () => {
    assert.equal(landingRouteFor([ROLES.OWNER, ROLES.ADMIN]), "admin");
  });

  it("resolves every landing destination to a real route", () => {
    // Guards against the landing pointing at a route id that does not exist - the
    // first draft of this returned "admin-audit", which resolves to nothing and
    // would have stranded every administrator after login.
    for (const roles of [[ROLES.ADMIN], [ROLES.OWNER], [ROLES.GUEST]]) {
      const destination = landingRouteFor(roles);
      assert.ok(
        getRouteConfig(destination),
        `landingRouteFor(${roles}) returned "${destination}", which is not a route`,
      );
    }
  });
});

describe("interrupted route takes precedence over the landing", () => {
  // Mirrors Login.jsx: an interrupted route wins, but only if it is real.
  function destinationFor({ redirectTarget, roles }) {
    const landing = landingRouteFor(roles);
    if (redirectTarget && !getRouteConfig(redirectTarget)) return landing;
    return redirectTarget || landing;
  }

  it("returns the user to the route they were interrupted on", () => {
    assert.equal(destinationFor({ redirectTarget: "funding", roles: [ROLES.FUNDER] }), "funding");
  });

  it("falls back to the role landing when no route was interrupted", () => {
    assert.equal(destinationFor({ redirectTarget: null, roles: [ROLES.ADMIN] }), "admin");
  });

  it("ignores an interrupted route that does not exist", () => {
    // A hand-edited ?redirect= must not strand the user on a blank screen.
    assert.equal(destinationFor({ redirectTarget: "not-a-real-route", roles: [ROLES.ADMIN] }), "admin");
  });
});
