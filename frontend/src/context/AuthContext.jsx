import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { DEMO_USERS, ROLES } from "../config/roles.js";
import { useSession } from "./SessionContext.jsx";
import { shortenAddress } from "../lib/chain.js";
import { isAdmin } from "../lib/roles.js";

const AuthContext = createContext(null);
const STORAGE_KEY = "qc_dao_active_user";

export function AuthProvider({ children }) {
  let session = null;
  try {
    session = useSession();
  } catch {
    // In standalone tests or environments without SessionProvider, session remains null
  }

  const [demoUser, setDemoUser] = useState(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    try {
      if (demoUser) {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(demoUser));
      } else {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {
      console.error("Failed to persist session:", e);
    }
  }, [demoUser]);

  const user = useMemo(() => {
    if (session?.isSignedIn && session?.profile) {
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
    return demoUser;
  }, [session?.isSignedIn, session?.profile, session?.address, demoUser]);

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

  const login = (roleOrProfile) => {
    if (!roleOrProfile || roleOrProfile === ROLES.GUEST) {
      setDemoUser(null);
      return;
    }

    if (typeof roleOrProfile === "string") {
      const profile = DEMO_USERS[roleOrProfile] || DEMO_USERS.member;
      if (profile) {
        setDemoUser(profile);
      }
    } else if (typeof roleOrProfile === "object") {
      setDemoUser(roleOrProfile);
    }
  };

  const logout = () => {
    setDemoUser(null);
    if (session?.signOut) {
      session.signOut();
    }
  };

  const value = {
    user,
    roles,
    role: roles[0] || ROLES.GUEST, // Primary role for legacy single-role display
    isAuthenticated: Boolean(user) && roles.some((r) => r !== ROLES.GUEST),
    isMultiRole: roles.filter((r) => r !== ROLES.GUEST).length > 1,
    hasRole,
    hasAnyRole,
    login,
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
