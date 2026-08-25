import { createContext, useContext, useEffect, useState } from "react";
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

  const login = (role) => {
    if (!role || role === ROLES.GUEST) {
      setUser(null);
      return;
    }
    const profile = DEMO_USERS[role];
    if (profile) {
      setUser(profile);
    }
  };

  const logout = () => {
    setUser(null);
  };

  const switchRole = (newRole) => {
    if (newRole === ROLES.GUEST) {
      logout();
    } else {
      login(newRole);
    }
  };

  const value = {
    user,
    role: user?.role || ROLES.GUEST,
    isAuthenticated: Boolean(user),
    login,
    logout,
    switchRole,
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
