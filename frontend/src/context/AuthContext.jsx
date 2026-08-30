import { createContext, useContext, useMemo } from "react";
import { ROLES } from "../config/roles.js";
import { useSession } from "./SessionContext.jsx";
import { shortenAddress } from "../lib/chain.js";
import { isAdmin } from "../lib/roles.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  let session = null;
  try {
    session = useSession();
  } catch {
    // In standalone tests or environments without SessionProvider, session remains null
  }

  const user = useMemo(() => {
    if (session?.isSignedIn && session?.profile) {
      if (session.profile.suspended) {
        return {
          id: session.address,
          name: session.profile.fullName || shortenAddress(session.address),
          org: session.profile.organisation || "QC Network",
          role: ROLES.GUEST,
          roles: [ROLES.GUEST],
          isSuspended: true,
        };
      }
      const isUserAdmin = isAdmin(session.profile.role);
      return {
        id: session.address,
        name: session.profile.fullName || shortenAddress(session.address),
        org: session.profile.organisation || "QC Network",
        role: isUserAdmin ? ROLES.ADMIN : ROLES.OWNER,
        roles: isUserAdmin
          ? [ROLES.ADMIN]
          : [ROLES.OWNER, ROLES.RESEARCHER, ROLES.EVALUATOR, ROLES.FUNDER],
      };
    }
    return null;
  }, [session?.isSignedIn, session?.profile, session?.address]);

  const roles = useMemo(() => {
    if (!user) return [ROLES.GUEST];
    if (Array.isArray(user.roles)) return user.roles;
    if (user.role) return [user.role];
    return [ROLES.GUEST];
  }, [user]);

  const hasRole = (targetRole) => roles.includes(targetRole);

  const hasAnyRole = (targetRoles) => {
    if (!targetRoles || targetRoles.length === 0) return true;
    return targetRoles.some((r) => roles.includes(r));
  };

  const logout = () => {
    if (session?.signOut) {
      return session.signOut();
    }
    return Promise.resolve({ ok: true });
  };

  const value = {
    user,
    roles,
    // Passed through from SessionContext so every consumer - route guards included -
    // can distinguish "not signed in" from "not known yet". Defaults to true when
    // there is no SessionProvider, because in that case nothing has resolved at all
    // and reporting "resolved, signed out" would be a lie.
    isLoading: session ? session.isLoading : true,
    role: roles[0] || ROLES.GUEST,
    isAuthenticated: Boolean(user) && roles.some((r) => r !== ROLES.GUEST) && !session?.profile?.suspended,
    isMultiRole: roles.filter((r) => r !== ROLES.GUEST).length > 1,
    isSuspended: Boolean(session?.profile?.suspended),
    hasRole,
    hasAnyRole,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
