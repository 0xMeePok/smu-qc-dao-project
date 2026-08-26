/**
 * Which routes need a session, and which need a particular role.
 *
 * This is the single source of truth the route guard reads - route protection is
 * declared here, in one table, rather than each page hand-rolling its own check and
 * its own redirect. Two components independently calling `go()` for the same route
 * race each other; one table plus one guard cannot.
 *
 * None of this is a security boundary. It decides what the browser *renders*, and a
 * determined user can edit their own JavaScript. The real enforcement is
 * firebase/firestore.rules, which pins `role` to 0 on create and immutable on every
 * client update, so a self-promoted `role: 1` in memory buys access to a page shell
 * and nothing else.
 */
import { isAdmin } from "./roles.js";

export const PUBLIC = "public";
export const AUTHENTICATED = "authenticated";
export const ADMIN = "admin";

// Only routes that need more than PUBLIC belong here; anything unlisted is public,
// so a new public page needs no entry and a typo'd route name fails open to public
// rather than silently locking people out of a page that should be reachable.
const ROUTE_ACCESS = {
  admin: ADMIN,
};

/**
 * Routes look like "admin" or "opportunity/qft-benchmark" - access is decided by the
 * first segment, so a detail page inherits its section's rule.
 */
export function accessFor(route) {
  const [section] = String(route ?? "").split("/");
  return ROUTE_ACCESS[section] ?? PUBLIC;
}

/**
 * Decides one access LEVEL against one session.
 *
 * Split out from canAccess() so each level can be tested directly. AUTHENTICATED is
 * implemented here but no route in the table uses it yet, and a test that can only
 * reach this logic through a route name cannot exercise that branch at all - the
 * alternative was a test that reimplements these rules, which would pass happily
 * while the real function was broken.
 */
export function allows(required, { isSignedIn = false, role = undefined } = {}) {
  if (required === PUBLIC) return true;
  if (!isSignedIn) return false;
  if (required === ADMIN) return isAdmin(role);
  return true;
}

export function canAccess(route, session = {}) {
  return allows(accessFor(route), session);
}

/**
 * Where a user belongs immediately after an interactive sign-in, when there is no
 * interrupted route to return them to.
 */
export function landingFor(role) {
  return isAdmin(role) ? "admin" : "home";
}
