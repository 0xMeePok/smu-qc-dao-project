import { useEffect } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { AccessDenied } from "./AccessDenied.jsx";

/**
 * RouteGuard
 * Enforces authentication and multi-role permission sets for UX routing (O1-KR4).
 *
 * ARCHITECTURAL NOTE: This component acts ONLY as a client-side UX mechanism to 
 * prevent unnecessary data fetches and provide smooth redirects. It is NOT a security 
 * boundary. True data authorization must be enforced via Firestore Security Rules 
 * and/or Cloud Functions to protect against direct API access.
 */
export function RouteGuard({ targetRoute, allowedRoles, authRequired, children, onNavigate }) {
  const { isAuthenticated, hasAnyRole } = useAuth();

  // 1. Check Authentication - Redirect to #/login?redirect=...
  useEffect(() => {
    if (authRequired && !isAuthenticated) {
      const redirectHash = `login?redirect=${encodeURIComponent(targetRoute || "home")}`;
      if (onNavigate) {
        onNavigate(redirectHash);
      } else {
        window.location.hash = `#/${redirectHash}`;
      }
    }
  }, [authRequired, isAuthenticated, targetRoute, onNavigate]);

  if (authRequired && !isAuthenticated) {
    return null;
  }

  // 2. Check Role Permissions (User must possess at least one permitted role)
  if (allowedRoles && allowedRoles.length > 0) {
    const hasPermission = hasAnyRole(allowedRoles);
    if (!hasPermission) {
      return (
        <AccessDenied
          targetRoute={targetRoute}
          requiredRoles={allowedRoles}
          onNavigate={onNavigate}
        />
      );
    }
  }

  // 3. Authorized
  return children;
}
