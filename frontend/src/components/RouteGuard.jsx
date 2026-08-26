import { useAuth } from "../context/AuthContext.jsx";
import { AccessDenied } from "./AccessDenied.jsx";
import { Login } from "./Login.jsx";

/**
 * RouteGuard
 * Enforces authentication and multi-role permission sets (O1-KR4).
 */
export function RouteGuard({ targetRoute, allowedRoles, authRequired, children, onNavigate }) {
  const { isAuthenticated, hasAnyRole } = useAuth();

  // 1. Check Authentication
  if (authRequired && !isAuthenticated) {
    return <Login redirectTarget={targetRoute} onNavigate={onNavigate} />;
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
