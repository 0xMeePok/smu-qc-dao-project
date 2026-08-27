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
  const { isAuthenticated, hasAnyRole, isLoading } = useAuth();

  // 1. Check Authentication - Redirect to #/login?redirect=...
  useEffect(() => {
    // Wait for the session to resolve before redirecting anyone. Firebase reports a
    // persisted session a tick AFTER mount, so on every refresh isAuthenticated is
    // briefly false for a user who is in fact signed in. Redirecting on that would
    // bounce them to #/login on each reload - the flash this guard exists to prevent.
    if (isLoading) return;
    if (authRequired && !isAuthenticated) {
      const redirectHash = `login?redirect=${encodeURIComponent(targetRoute || "home")}`;
      if (onNavigate) {
        onNavigate(redirectHash);
      } else {
        window.location.hash = `#/${redirectHash}`;
      }
    }
  }, [isLoading, authRequired, isAuthenticated, targetRoute, onNavigate]);

  // Render nothing while the role is unresolved, so a protected screen never appears
  // before we know the viewer may see it - and equally, never flashes AccessDenied at
  // someone who turns out to be authorised.
  if (isLoading) {
    return (
      <section className="page empty" role="status" aria-live="polite">
        <p className="lead">Restoring your session…</p>
      </section>
    );
  }

  if (authRequired && !isAuthenticated) {
    return null;
  }

  // 2. Check Role Permissions (User must possess at least one permitted role)
  if (authRequired && allowedRoles && allowedRoles.length > 0) {
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
