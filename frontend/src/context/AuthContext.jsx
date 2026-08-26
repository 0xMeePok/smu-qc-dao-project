import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { DEMO_USERS, ROLES } from "../config/roles.js";

const AuthContext = createContext(null);
const STORAGE_KEY = "qc_dao_active_user";

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    try {
      if (user) {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(user));
      } else {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {
      console.error("Failed to persist session:", e);
    }
  }, [user]);

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
      setUser(null);
      return;
    }

    if (typeof roleOrProfile === "string") {
      const profile = DEMO_USERS[roleOrProfile] || DEMO_USERS.member;
      if (profile) {
        setUser(profile);
      }
    } else if (typeof roleOrProfile === "object") {
      setUser(roleOrProfile);
    }
  };

  const logout = () => {
    setUser(null);
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
