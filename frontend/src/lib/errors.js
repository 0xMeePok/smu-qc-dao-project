// Every failure the onboarding flow can surface, mapped to language a non-technical
// user can act on. Anything unmapped falls back to a message that still tells the
// user what to do next rather than printing a raw code at them.

const FIREBASE_AUTH_MESSAGES = {
  // The project's Authentication product has never been provisioned - visiting
  // Firestore or Functions does not do this on its own. See docs/firebase-setup.md.
  "auth/operation-not-allowed":
    "Authentication is not set up for this Firebase project yet. Open the Authentication tab in the Firebase console and complete its first-time setup.",
  "auth/admin-restricted-operation":
    "Authentication is not set up for this Firebase project yet. Open the Authentication tab in the Firebase console and complete its first-time setup.",
  "auth/network-request-failed":
    "We could not reach the authentication service. Check your internet connection and try again.",
  "auth/too-many-requests":
    "Too many attempts from this device. Wait a few minutes before trying again.",
  "auth/internal-error":
    "The authentication service returned an unexpected error. Please try again.",
  "auth/user-disabled": "That account has been disabled. Contact the platform administrators.",
  "auth/invalid-api-key":
    "The Firebase API key is missing or wrong. Check the VITE_FIREBASE_* values in frontend/.env.local (or frontend/.env).",
};

// Callable-function failures. `internal` is what the SDK reports when the HTTP
// request never produced a valid response at all - which is exactly what happens
// when the function is not deployed: the 404 HTML page carries no CORS headers, so
// the browser reports a CORS violation and the SDK sees nothing usable. Saying
// "not deployed" is far more useful than repeating "internal".
const FUNCTIONS_MESSAGES = {
  "functions/internal":
    "Could not reach the sign-in server. The Cloud Functions are most likely not deployed yet — run `firebase deploy --only functions` (this needs the Blaze plan), or set VITE_FIREBASE_USE_EMULATORS=true to work locally.",
  "functions/not-found":
    "The sign-in function does not exist in this project. Deploy it with `firebase deploy --only functions`.",
  "functions/unavailable":
    "The sign-in server is unreachable. Check your connection, then confirm the Cloud Functions are deployed.",
  "functions/permission-denied":
    "You do not have permission to perform this action. Administrator privileges may be required.",
  "functions/unauthenticated":
    "The sign-in server rejected the request as unauthenticated. Confirm the functions allow unauthenticated invocation.",
  "functions/failed-precondition":
    "No sign-in request is pending for this wallet. Start the sign-in again.",
  "functions/deadline-exceeded":
    "The sign-in server took too long to respond. Please try again.",
  "functions/resource-exhausted":
    "A sign-in request was just issued for this wallet. Wait a few seconds and try again.",
};

const FIRESTORE_MESSAGES = {
  "permission-denied":
    "Your details were rejected by our security rules. Check every field and try again. If this wallet is already registered, sign in with it instead.",
  unavailable:
    "We could not reach the database. Check your internet connection and try again.",
  "deadline-exceeded": "The database took too long to respond. Please try again.",
  unauthenticated: "Your session expired before we could save your profile. Please try again.",
  "failed-precondition":
    "The database is not ready yet. Confirm Firestore has been created in the Firebase console.",
};

export class OnboardingError extends Error {
  constructor(message, { field = null, cause = null } = {}) {
    super(message);
    this.name = "OnboardingError";
    this.field = field;
    this.cause = cause;
  }
}

export function messageForFirebaseError(error) {
  // Firebase's own SDKs always use string codes ("auth/xyz", "permission-denied").
  // This function is also the catch-all for the chain-switch step in signIn() and
  // for whatever a wallet extension throws, though - and EIP-1193 wallet errors
  // (Backpack, MetaMask, etc.) commonly carry a NUMERIC code (4001, 4902, -32603).
  // `error?.code ?? ""` only guards against undefined/null, so a numeric code sailed
  // through as a number and crashed the very first `.includes()` call below with
  // "code.includes is not a function" - hiding whatever the wallet's real error was
  // behind a JS crash instead of showing it. Coercing to a string up front fixes it
  // for every error shape, not just Firebase's.
  const code = String(error?.code ?? "");

  if (error?.message && typeof error.message === "string" && error.message.toLowerCase().includes("suspended")) {
    return "Your account has been suspended, contact an administrator.";
  }

  if (FIREBASE_AUTH_MESSAGES[code]) return FIREBASE_AUTH_MESSAGES[code];
  if (FUNCTIONS_MESSAGES[code]) return FUNCTIONS_MESSAGES[code];

  // Firestore codes arrive either bare ("permission-denied") or namespaced
  // ("firestore/permission-denied") depending on which SDK surface threw.
  const bare = code.includes("/") ? code.split("/").pop() : code;
  if (FIRESTORE_MESSAGES[bare]) return FIRESTORE_MESSAGES[bare];

  if (error instanceof OnboardingError) return error.message;

  // Surface whatever the wallet/SDK actually said instead of a pure guess - this is
  // what lets a genuinely wallet-specific failure (e.g. a chain switch Backpack
  // itself refuses) be diagnosed from what the user sees, rather than staying invisible.
  const detail = error?.shortMessage || error?.reason || error?.message;
  return detail
    ? `Something went wrong: ${detail}`
    : "Something went wrong. Please try again, and contact the platform team if it keeps happening.";
}

// Wallet-level failures (connect rejected, wrong network, extension errors) are
// handled inline where they occur - see ConnectWalletModal.jsx and
// SessionContext.jsx, both of which check `error.name === "UserRejectedRequestError"`
// on the error objects wagmi throws. There is no separate raw-EIP-1193 error path
// left to map here now that wagmi owns the wallet connection.

export function fieldForFirebaseError(error) {
  if (error instanceof OnboardingError) return error.field;
  return null;
}
