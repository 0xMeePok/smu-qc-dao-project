import { initializeApp, getApps } from "firebase/app";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  indexedDBLocalPersistence,
  setPersistence,
} from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// Must match the region the callable functions are deployed to (see firebase/functions/index.js).
export const FUNCTIONS_REGION = "asia-southeast1";

// Only these three are load-bearing for this app:
//   apiKey    - Identity Toolkit (custom-token sign-in) and Firestore
//   projectId - Firestore and the callable Cloud Functions
//   appId     - app identity used by the SDK
// authDomain matters only for OAuth popup/redirect flows (Google, GitHub, email
// link), which this app does not use - verified: signInWithCustomToken succeeds
// with it absent. storageBucket and messagingSenderId are for Storage and FCM,
// neither of which is wired up. Keep them in .env if you like; a missing one must
// not stop the app from starting.
const REQUIRED_KEYS = ["apiKey", "projectId", "appId"];

export const missingFirebaseConfig = REQUIRED_KEYS
  .filter((key) => !config[key])
  .map((key) => `VITE_FIREBASE_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`);

export const isFirebaseConfigured = missingFirebaseConfig.length === 0;

const app = isFirebaseConfigured ? (getApps()[0] ?? initializeApp(config)) : null;

const appCheckSiteKey = import.meta.env.VITE_FIREBASE_APP_CHECK_SITE_KEY;
export const isAppCheckConfigured = Boolean(appCheckSiteKey);

// Production nonce issuance enforces App Check and consumes a limited-use token.
// Local emulators deliberately skip attestation so automated/local testing remains
// possible without weakening the deployed function.
export const appCheck = app
  && import.meta.env.VITE_FIREBASE_USE_EMULATORS !== "true"
  && appCheckSiteKey
  ? initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  })
  : null;

export const auth = app ? getAuth(app) : null;

// Persist the session across reloads AND across closing the tab, so a refresh in the
// middle of a multi-step workflow does not throw the user back to sign-in.
//
// indexedDBLocalPersistence first, browserLocalPersistence second. Note that despite
// the name, browserLocalPersistence is localStorage - indexedDBLocalPersistence is the
// IndexedDB one. IndexedDB is preferred because it is Firebase's own default and is
// not subject to localStorage's small synchronous quota, but the two are equivalent
// for security: both are readable by any script on this origin, so neither protects a
// token from XSS. That is what the Content-Security-Policy in firebase/firebase.json
// is for.
//
// Session LENGTH is not decided here - either option keeps a session indefinitely.
// SessionContext enforces the idle cap on top.
if (auth) {
  setPersistence(auth, indexedDBLocalPersistence)
    .catch((indexedDbError) => {
      // Falls back rather than failing: some browsers block IndexedDB in private
      // windows or under strict privacy settings, and localStorage still works there.
      console.warn(
        "[auth] IndexedDB persistence unavailable, falling back to localStorage.",
        indexedDbError,
      );
      return setPersistence(auth, browserLocalPersistence);
    })
    .catch((error) => {
      // Both failed. Firebase silently drops to IN-MEMORY persistence here, which
      // means the session dies on every reload - the exact thing this app is built
      // not to do. Previously this was swallowed by an empty catch, so the app
      // degraded invisibly and looked like an unrelated bug. Warn loudly instead.
      console.error(
        "[auth] Session persistence could not be configured. The session will NOT "
        + "survive a page reload. Check whether this browser is blocking site data.",
        error,
      );
    });
}

export const db = app ? getFirestore(app) : null;
export const functions = app ? getFunctions(app, FUNCTIONS_REGION) : null;

if (app && import.meta.env.VITE_FIREBASE_USE_EMULATORS === "true") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}

export default app;
