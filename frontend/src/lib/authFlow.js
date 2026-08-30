import { httpsCallable } from "firebase/functions";
import { signInWithCustomToken } from "firebase/auth";
import { auth, functions, isFirebaseConfigured, missingFirebaseConfig } from "./firebase.js";
import { OnboardingError } from "./errors.js";

/**
 * Sign-in with Ethereum, verified server side.
 *
 *   1. Ask the server for a single-use nonce. It returns the exact message to sign.
 *   2. The wallet signs that message (wagmi does this part).
 *   3. The server re-derives the message from its own stored nonce, verifies the
 *      signature, burns the nonce, and mints a Firebase custom token whose uid is
 *      the wallet address.
 *   4. We sign in with that token.
 *
 * The browser never decides who it is. `request.auth.uid` can only ever be an address
 * whose signature this server checked, which is what makes the Firestore rules sound.
 */
export function requireFirebase() {
  if (!isFirebaseConfigured) {
    throw new OnboardingError(
      `Firebase is not configured yet. Add ${missingFirebaseConfig.join(", ")} to frontend/.env.local (or frontend/.env) and restart the dev server.`,
    );
  }
}

export async function requestSignInMessage(address) {
  requireFirebase();
  const getSiweNonce = httpsCallable(functions, "getSiweNonce", {
    limitedUseAppCheckTokens: true,
  });
  const { data } = await getSiweNonce({ address });
  if (!data?.message) {
    throw new OnboardingError("The server did not return a message to sign. Try again.");
  }
  return data.message;
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

export async function exchangeSignatureForSession({ address, signature }) {
  requireFirebase();
  const verifySiweSignature = httpsCallable(functions, "verifySiweSignature");
  const { data } = await verifySiweSignature({ address, signature });
  if (!data?.token) {
    throw new OnboardingError("The server did not return a session token. Try again.");
  }
  await signInWithCustomToken(auth, data.token);
  return data.address;
}
