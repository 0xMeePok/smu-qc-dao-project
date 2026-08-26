import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "../../src/config/roles.js";
import { ROUTES_CONFIG, evaluateRouteAccess, getRouteConfig } from "../../src/config/routes.js";
import { ROLE_ADMIN, ROLE_USER, isAdmin } from "../../src/lib/roles.js";
import { shortenAddress } from "../../src/lib/chain.js";

/**
 * Derives AuthContext state from a given SessionContext snapshot.
 * Mirrors the exact contract and state derivations in frontend/src/context/AuthContext.jsx.
 */
function deriveAuthState(session) {
  let user = null;
  if (session?.isSignedIn && session?.profile) {
    const isUserAdmin = isAdmin(session.profile.role);
    user = {
      id: session.address,
      name: session.profile.fullName || shortenAddress(session.address),
      org: session.profile.organisation || "QC Network",
      role: isUserAdmin ? ROLES.ADMIN : ROLES.OWNER,
      roles: isUserAdmin
        ? [ROLES.ADMIN]
        : [ROLES.OWNER, ROLES.RESEARCHER, ROLES.EVALUATOR, ROLES.FUNDER],
    };
  }

  const roles = !user
    ? [ROLES.GUEST]
    : Array.isArray(user.roles)
      ? user.roles
      : user.role
        ? [user.role]
        : [ROLES.GUEST];

  const hasRole = (targetRole) => roles.includes(targetRole);

  const hasAnyRole = (targetRoles) => {
    if (!targetRoles || targetRoles.length === 0) return true;
    return targetRoles.some((r) => roles.includes(r));
  };

  const logout = () => {
    if (session?.signOut) {
      session.signOut();
    }
  };

  return {
    user,
    roles,
    role: roles[0] || ROLES.GUEST,
    isAuthenticated: Boolean(user) && roles.some((r) => r !== ROLES.GUEST),
    isMultiRole: roles.filter((r) => r !== ROLES.GUEST).length > 1,
    hasRole,
    hasAnyRole,
    logout,
  };
}

/**
 * Simulates RouteGuard decision and rendering behavior against an AuthContext state.
 * Mirrors the exact guard flow in frontend/src/components/RouteGuard.jsx.
 */
function runRouteGuard({ targetRoute, allowedRoles, authRequired, authState, onNavigate }) {
  const { isAuthenticated, hasAnyRole } = authState;

  // 1. Check Authentication - Redirect to login?redirect=...
  if (authRequired && !isAuthenticated) {
    const redirectHash = `login?redirect=${encodeURIComponent(targetRoute || "home")}`;
    if (onNavigate) {
      onNavigate(redirectHash);
    }
    return { outcome: "REDIRECT", target: redirectHash, rendered: null };
  }

  // 2. Check Role Permissions
  if (allowedRoles && allowedRoles.length > 0) {
    const hasPermission = hasAnyRole(allowedRoles);
    if (!hasPermission) {
      return {
        outcome: "ACCESS_DENIED",
        target: targetRoute,
        rendered: "AccessDenied",
        requiredRoles: allowedRoles,
      };
    }
  }

  // 3. Authorized
  return { outcome: "AUTHORIZED", target: targetRoute, rendered: "Children" };
}

/**
 * Simulates Login component auto-redirection on authentication.
 * Mirrors frontend/src/components/Login.jsx.
 */
function runLoginComponent({ redirectTarget, authState, onNavigate }) {
  if (authState.isAuthenticated) {
    const destination = redirectTarget || "home";
    if (onNavigate) {
      onNavigate(destination);
    }
    return { isRedirected: true, destination };
  }
  return { isRedirected: false, destination: null, rendered: "SignInWithWallet" };
}

describe("Integration Tests: AuthContext, RouteGuard & Access Control Pipeline", () => {
  const guestSession = {
    isSignedIn: false,
    profile: null,
    address: null,
  };

  const participantSession = {
    isSignedIn: true,
    address: "0x1111111111111111111111111111111111111111",
    profile: {
      fullName: "Dr. Alice Researcher",
      organisation: "SMU Quantum Lab",
      role: ROLE_USER,
    },
  };

  const adminSession = {
    isSignedIn: true,
    address: "0x2222222222222222222222222222222222222222",
    profile: {
      fullName: "Admin Bob",
      organisation: "SMU QC DAO Governance",
      role: ROLE_ADMIN,
    },
  };

  describe("1. AuthContext State & Multi-Role Resolution", () => {
    it("[INT-AUTH-001] should derive unauthenticated guest state when session is signed out", () => {
      const auth = deriveAuthState(guestSession);
      assert.equal(auth.isAuthenticated, false);
      assert.equal(auth.user, null);
      assert.deepEqual(auth.roles, [ROLES.GUEST]);
      assert.equal(auth.role, ROLES.GUEST);
      assert.equal(auth.isMultiRole, false);
      assert.equal(auth.hasRole(ROLES.GUEST), true);
      assert.equal(auth.hasRole(ROLES.OWNER), false);
      assert.equal(auth.hasRole(ROLES.ADMIN), false);
    });

    it("[INT-AUTH-002] should resolve participant session into multi-role capability set (owner, researcher, evaluator, funder)", () => {
      const auth = deriveAuthState(participantSession);
      assert.equal(auth.isAuthenticated, true);
      assert.ok(auth.user);
      assert.equal(auth.user.id, participantSession.address);
      assert.equal(auth.user.name, "Dr. Alice Researcher");
      assert.equal(auth.user.org, "SMU Quantum Lab");
      assert.equal(auth.isMultiRole, true);
      assert.deepEqual(auth.roles, [
        ROLES.OWNER,
        ROLES.RESEARCHER,
        ROLES.EVALUATOR,
        ROLES.FUNDER,
      ]);
      assert.equal(auth.hasRole(ROLES.OWNER), true);
      assert.equal(auth.hasRole(ROLES.RESEARCHER), true);
      assert.equal(auth.hasRole(ROLES.EVALUATOR), true);
      assert.equal(auth.hasRole(ROLES.FUNDER), true);
      assert.equal(auth.hasRole(ROLES.ADMIN), false);
    });

    it("[INT-AUTH-003] should isolate DAO Admin session to admin capability only", () => {
      const auth = deriveAuthState(adminSession);
      assert.equal(auth.isAuthenticated, true);
      assert.ok(auth.user);
      assert.equal(auth.user.name, "Admin Bob");
      assert.equal(auth.user.role, ROLES.ADMIN);
      assert.deepEqual(auth.roles, [ROLES.ADMIN]);
      assert.equal(auth.isMultiRole, false);
      assert.equal(auth.hasRole(ROLES.ADMIN), true);
      assert.equal(auth.hasRole(ROLES.OWNER), false);
      assert.equal(auth.hasRole(ROLES.RESEARCHER), false);
    });

    it("[INT-AUTH-004] should delegate logout to SessionContext signOut", () => {
      let signedOut = false;
      const customSession = {
        ...participantSession,
        signOut: () => {
          signedOut = true;
        },
      };
      const auth = deriveAuthState(customSession);
      auth.logout();
      assert.equal(signedOut, true);
    });
  });

  describe("2. RouteGuard Component Integration", () => {
    it("[INT-GUARD-001] should redirect unauthenticated guests to login preserving redirect target", () => {
      const auth = deriveAuthState(guestSession);
      const protectedRoutes = ["create", "my-problems", "proposals", "evaluations", "funding", "admin"];

      for (const route of protectedRoutes) {
        const config = getRouteConfig(route);
        let navigatedTo = null;
        const result = runRouteGuard({
          targetRoute: route,
          allowedRoles: config.allowedRoles,
          authRequired: config.authRequired,
          authState: auth,
          onNavigate: (dest) => {
            navigatedTo = dest;
          },
        });

        assert.equal(result.outcome, "REDIRECT");
        assert.equal(result.rendered, null);
        assert.equal(navigatedTo, `login?redirect=${encodeURIComponent(route)}`);
      }
    });

    it("[INT-GUARD-002] should allow multi-role participant into all participant workspaces and Create Brief", () => {
      const auth = deriveAuthState(participantSession);
      const participantRoutes = ["create", "my-problems", "proposals", "evaluations", "funding"];

      for (const route of participantRoutes) {
        const config = getRouteConfig(route);
        let navigatedTo = null;
        const result = runRouteGuard({
          targetRoute: route,
          allowedRoles: config.allowedRoles,
          authRequired: config.authRequired,
          authState: auth,
          onNavigate: (dest) => {
            navigatedTo = dest;
          },
        });

        assert.equal(result.outcome, "AUTHORIZED");
        assert.equal(result.rendered, "Children");
        assert.equal(navigatedTo, null, "Should not trigger any redirect for authorized route");
      }
    });

    it("[INT-GUARD-003] should render AccessDenied when multi-role participant attempts to access Admin Audit route", () => {
      const auth = deriveAuthState(participantSession);
      const adminConfig = getRouteConfig("admin");
      let navigatedTo = null;

      const result = runRouteGuard({
        targetRoute: "admin",
        allowedRoles: adminConfig.allowedRoles,
        authRequired: adminConfig.authRequired,
        authState: auth,
        onNavigate: (dest) => {
          navigatedTo = dest;
        },
      });

      assert.equal(result.outcome, "ACCESS_DENIED");
      assert.equal(result.rendered, "AccessDenied");
      assert.deepEqual(result.requiredRoles, [ROLES.ADMIN]);
      assert.equal(navigatedTo, null);
    });

    it("[INT-GUARD-004] should allow DAO Admin to access Admin Audit console", () => {
      const auth = deriveAuthState(adminSession);
      const adminConfig = getRouteConfig("admin");
      let navigatedTo = null;

      const result = runRouteGuard({
        targetRoute: "admin",
        allowedRoles: adminConfig.allowedRoles,
        authRequired: adminConfig.authRequired,
        authState: auth,
        onNavigate: (dest) => {
          navigatedTo = dest;
        },
      });

      assert.equal(result.outcome, "AUTHORIZED");
      assert.equal(result.rendered, "Children");
      assert.equal(navigatedTo, null);
    });

    it("[INT-GUARD-005] should render AccessDenied when DAO Admin attempts to access participant workspaces", () => {
      const auth = deriveAuthState(adminSession);
      const restrictedRoutes = ["create", "my-problems", "proposals", "evaluations", "funding"];

      for (const route of restrictedRoutes) {
        const config = getRouteConfig(route);
        let navigatedTo = null;

        const result = runRouteGuard({
          targetRoute: route,
          allowedRoles: config.allowedRoles,
          authRequired: config.authRequired,
          authState: auth,
          onNavigate: (dest) => {
            navigatedTo = dest;
          },
        });

        assert.equal(result.outcome, "ACCESS_DENIED", `Admin must be denied access to ${route}`);
        assert.equal(result.rendered, "AccessDenied");
        assert.equal(navigatedTo, null);
      }
    });
  });

  describe("3. Login Component Redirection Flow", () => {
    it("[INT-LOGIN-001] should render sign-in and remain on login screen when user is unauthenticated", () => {
      const auth = deriveAuthState(guestSession);
      let navigatedTo = null;

      const result = runLoginComponent({
        redirectTarget: "create",
        authState: auth,
        onNavigate: (dest) => {
          navigatedTo = dest;
        },
      });

      assert.equal(result.isRedirected, false);
      assert.equal(result.rendered, "SignInWithWallet");
      assert.equal(navigatedTo, null);
    });

    it("[INT-LOGIN-002] should automatically navigate to redirectTarget upon authentication", () => {
      const auth = deriveAuthState(participantSession);
      let navigatedTo = null;

      const result = runLoginComponent({
        redirectTarget: "evaluations",
        authState: auth,
        onNavigate: (dest) => {
          navigatedTo = dest;
        },
      });

      assert.equal(result.isRedirected, true);
      assert.equal(result.destination, "evaluations");
      assert.equal(navigatedTo, "evaluations");
    });

    it("[INT-LOGIN-003] should default navigation to home upon authentication if no redirectTarget provided", () => {
      const auth = deriveAuthState(participantSession);
      let navigatedTo = null;

      const result = runLoginComponent({
        redirectTarget: null,
        authState: auth,
        onNavigate: (dest) => {
          navigatedTo = dest;
        },
      });

      assert.equal(result.isRedirected, true);
      assert.equal(result.destination, "home");
      assert.equal(navigatedTo, "home");
    });
  });

  describe("4. End-to-End Route Access Evaluations", () => {
    it("[FIT-AAR-001] should grant unauthenticated guests access to all public routes", () => {
      const guestAuth = deriveAuthState(guestSession);
      const publicRoutes = ["home", "discover", "opportunity", "login", "access-denied"];

      for (const route of publicRoutes) {
        const decision = evaluateRouteAccess(route, guestAuth.user);
        assert.equal(decision.status, 200, `Guest should access public route: ${route}`);
        assert.equal(decision.allowed, true);
        assert.equal(decision.action, "RENDER");
      }
    });

    it("[FIT-AAR-002] should redirect unauthenticated guests when accessing protected routes", () => {
      const guestAuth = deriveAuthState(guestSession);
      const protectedRoutes = [
        "create",
        "my-problems",
        "proposals",
        "evaluations",
        "funding",
        "admin",
      ];

      for (const route of protectedRoutes) {
        const decision = evaluateRouteAccess(route, guestAuth.user);
        assert.equal(decision.status, 302);
        assert.equal(decision.allowed, false);
        assert.equal(decision.action, "REDIRECT_LOGIN");
        assert.equal(decision.target, `login?redirect=${encodeURIComponent(route)}`);
      }
    });

    it("[FIT-AAR-003] should grant multi-role participant access across all 4 workspaces and Create Brief", () => {
      const memberAuth = deriveAuthState(participantSession);
      const workspaces = ["create", "my-problems", "proposals", "evaluations", "funding"];

      for (const ws of workspaces) {
        const decision = evaluateRouteAccess(ws, memberAuth.user);
        assert.equal(decision.status, 200, `Member should access: ${ws}`);
        assert.equal(decision.allowed, true);
        assert.equal(decision.action, "RENDER");
      }
    });

    it("[FIT-AAR-004] should isolate DAO Admin from participant workspaces and grant Admin Audit", () => {
      const adminAuth = deriveAuthState(adminSession);

      const adminDecision = evaluateRouteAccess("admin", adminAuth.user);
      assert.equal(adminDecision.status, 200);
      assert.equal(adminDecision.allowed, true);

      const restricted = ["create", "my-problems", "proposals", "evaluations", "funding"];
      for (const route of restricted) {
        const decision = evaluateRouteAccess(route, adminAuth.user);
        assert.equal(decision.status, 403, `Admin must be 403 Forbidden from: ${route}`);
        assert.equal(decision.allowed, false);
        assert.equal(decision.action, "DENY_403");
      }
    });
  });
});
