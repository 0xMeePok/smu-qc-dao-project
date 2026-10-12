import { httpsCallable } from "firebase/functions";
import { signInWithCustomToken } from "firebase/auth";
import { auth, functions, isFirebaseConfigured, missingFirebaseConfig } from "./firebase.js";
import { OnboardingError } from "./errors.js";

/**
 * Privy has already authenticated the email. This exchanges that session for
 * the Firebase session the rest of the app trusts.
 *
 *   1. The browser sends Privy's access token. It does not name the account.
 *   2. The server verifies the token, reads the embedded wallet from Privy, and
 *      mints a Firebase custom token whose uid is that address.
 *   3. We sign in with that token.
 *
 * `request.auth.uid` can only be an address Privy linked to this email. A
 * browser cannot choose a different one.
 */
export function requireFirebase() {
  if (!isFirebaseConfigured) {
    throw new OnboardingError(
      `Firebase is not configured yet. Add ${missingFirebaseConfig.join(", ")} to frontend/.env.local (or frontend/.env) and restart the dev server.`,
    );
  }
}

export async function revokeOwnSessions() {
  requireFirebase();
  const revoke = httpsCallable(functions, "revokeOwnSessions");
  const { data } = await revoke();
  if (!data?.success) {
    throw new OnboardingError("The server could not invalidate this session. Retry sign out.");
  }
  return data;
}

export async function exchangePrivySession(accessToken) {
  requireFirebase();
  if (typeof accessToken !== "string" || accessToken.split(".").length !== 3) {
    throw new OnboardingError("Sign-in did not return a session. Try again.");
  }
  const exchange = httpsCallable(functions, "exchangePrivySession");
  const { data } = await exchange({ accessToken });
  if (!data?.token || !/^0x[0-9a-f]{40}$/.test(data.address ?? "")) {
    throw new OnboardingError("The server did not return a session token. Try again.");
  }
  await signInWithCustomToken(auth, data.token);
  return data.address;
}
