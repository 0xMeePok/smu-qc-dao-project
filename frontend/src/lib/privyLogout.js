let logoutPrivySession = async () => {};

/** Registered by PrivyLogoutBridge while PrivyProvider is mounted. */
export function registerPrivyLogout(logout) {
  logoutPrivySession = typeof logout === "function" ? logout : async () => {};
}

export function logoutPrivy() {
  return logoutPrivySession();
}
