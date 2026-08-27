import { ROLES } from "./roles.js";

/**
 * Route Configuration Definitions
 * - key: Unique route identifier used in URL hash (`#/${key}`)
 * - label: Text shown in navigation
 * - allowedRoles: Array of permitted roles (or null for public)
 * - showInNav: Whether to display in top header for permitted roles
 * - authRequired: Boolean indicating whether route requires authentication
 */
export const ROUTES_CONFIG = [
  {
    key: "home",
    path: "home",
    label: "Home",
    allowedRoles: null, // Public
    authRequired: false,
    showInNav: true,
  },
  {
    key: "discover",
    path: "discover",
    label: "Discover",
    allowedRoles: null, // Public
    authRequired: false,
    showInNav: true,
  },
  {
    key: "profile",
    path: "profile",
    label: "Profile",
    allowedRoles: null,
    authRequired: true,
    showInNav: true,
  },
  {
    key: "create",
    path: "create",
    label: "Create Brief",
    allowedRoles: [ROLES.OWNER, ROLES.RESEARCHER, ROLES.FUNDER],
    authRequired: true,
    showInNav: true,
  },
  {
    key: "my-problems",
    path: "my-problems",
    label: "My Problems",
    allowedRoles: [ROLES.OWNER],
    authRequired: true,
    showInNav: true,
  },
  {
    key: "proposals",
    path: "proposals",
    label: "My Proposals",
    allowedRoles: [ROLES.RESEARCHER],
    authRequired: true,
    showInNav: true,
  },
  {
    key: "evaluations",
    path: "evaluations",
    label: "Evaluation Queue",
    allowedRoles: [ROLES.EVALUATOR],
    authRequired: true,
    showInNav: true,
  },
  {
    key: "funding",
    path: "funding",
    label: "Funding Portfolio",
    allowedRoles: [ROLES.FUNDER],
    authRequired: true,
    showInNav: true,
  },
  {
    key: "admin",
    path: "admin",
    label: "Admin Audit",
    allowedRoles: [ROLES.ADMIN],
    authRequired: true,
    showInNav: true,
  },
  // Non-navigated or dynamic/utility routes:
  {
    key: "opportunity",
    path: "opportunity",
    label: "Opportunity Detail",
    allowedRoles: null, // Public
    authRequired: false,
    showInNav: false,
  },
  {
    key: "login",
    path: "login",
    label: "Sign In",
    allowedRoles: null, // Public
    authRequired: false,
    showInNav: false,
  },
  {
    key: "access-denied",
    path: "access-denied",
    label: "Access Denied",
    allowedRoles: null, // Public error view
    authRequired: false,
    showInNav: false,
  },
];

export function getRouteConfig(routeKey) {
  return ROUTES_CONFIG.find((route) => route.key === routeKey);
}

/**
 * Returns navigation routes permitted for the given role or list of roles.
 */
export function getPermittedNavRoutes(roles) {
  const roleList = Array.isArray(roles) ? roles : roles ? [roles] : [];
  return ROUTES_CONFIG.filter((route) => {
    if (!route.showInNav) return false;
    if (!route.authRequired) return true;
    if (roleList.length === 0 || (roleList.length === 1 && roleList[0] === ROLES.GUEST)) return false;
    return route.allowedRoles?.some((allowed) => roleList.includes(allowed));
  });
}

/**
 * Evaluates route access for a given route key and user profile.
 * Core authorization logic shared by RouteGuard and test suites.
 */
export function evaluateRouteAccess(routeKey, user) {
  const routeConfig = getRouteConfig(routeKey);
  if (!routeConfig) {
    return { status: 404, allowed: false, action: "NOT_FOUND" };
  }

  // 1. Public route check
  if (!routeConfig.authRequired) {
    return { status: 200, allowed: true, action: "RENDER" };
  }

  // 2. Authentication check
  const userRoles = Array.isArray(user?.roles) ? user.roles : user?.role ? [user.role] : [];
  const isAuthenticated = Boolean(user) && userRoles.some((r) => r !== ROLES.GUEST);

  if (!isAuthenticated) {
    return {
      status: 302,
      allowed: false,
      action: "REDIRECT_LOGIN",
      target: `login?redirect=${encodeURIComponent(routeKey)}`,
    };
  }

  // 3. Capability / set intersection check
  const hasCapability = routeConfig.allowedRoles?.some((role) => userRoles.includes(role));

  if (hasCapability) {
    return { status: 200, allowed: true, action: "RENDER" };
  }

  // 4. Unauthorized role
  return { status: 403, allowed: false, action: "DENY_403" };
}
