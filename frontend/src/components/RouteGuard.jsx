import { useAuth } from "../context/AuthContext.jsx";
import { AccessDenied } from "./AccessDenied.jsx";
import { Login } from "./Login.jsx";

/**
 * RouteGuard
 * Enforces authentication and role-based permissions (O1-KR4).
 */
export function RouteGuard({ targetRoute, allowedRoles, authRequired, children, onNavigate }) {
  const { isAuthenticated, role } = useAuth();

  // 1. Check Authentication
  if (authRequired && !isAuthenticated) {
    return <Login redirectTarget={targetRoute} onNavigate={onNavigate} />;
  }

  // 2. Check Role Permissions
  if (allowedRoles && allowedRoles.length > 0) {
    const hasPermission = allowedRoles.includes(role);
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
