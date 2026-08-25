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

export function getPermittedNavRoutes(role) {
  return ROUTES_CONFIG.filter((route) => {
    if (!route.showInNav) return false;
    if (!route.authRequired) return true;
    if (!role || role === ROLES.GUEST) return false;
    return route.allowedRoles?.includes(role);
  });
}
