import { initializeApp, getApps } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  indexedDBLocalPersistence,
  setPersistence,
} from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";
import { getStorage, connectStorageEmulator } from "firebase/storage";

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
const usingEmulators = import.meta.env.VITE_FIREBASE_USE_EMULATORS === "true";

const appCheckSiteKey = import.meta.env.VITE_FIREBASE_APP_CHECK_SITE_KEY;
export const isAppCheckConfigured = Boolean(appCheckSiteKey);

// Production nonce issuance enforces App Check and consumes a limited-use token.
// Firebase App Check now registers web apps only with reCAPTCHA Enterprise
// (score-based key). The same site key must be saved in the Firebase console
// and in VITE_FIREBASE_APP_CHECK_SITE_KEY. Local emulators skip attestation.
export const appCheck = app
  && import.meta.env.VITE_FIREBASE_USE_EMULATORS !== "true"
  && appCheckSiteKey
  ? initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  })
  : null;

export const auth = app ? getAuth(app) : null;

// Connect the emulator before configuring persistence or registering auth listeners.
// Those operations initialize the auth instance and can otherwise retain the
// production token endpoint for refresh requests.
if (auth && usingEmulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
}

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

// Posting attachments (QCDAO-58). storageBucket is optional for the rest of the
// app, so this is null when it is absent rather than throwing at import time -
// frontend/src/lib/attachments.js reports that as a configuration error the user
// can act on, instead of the whole module failing to load.
export const isStorageConfigured = Boolean(app && config.storageBucket);
export const storage = isStorageConfigured ? getStorage(app) : null;

if (app && usingEmulators) {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  if (storage) connectStorageEmulator(storage, "127.0.0.1", 9199);
}

// True when the page is served from localhost but Storage is pointed at the REAL
// bucket, because VITE_FIREBASE_USE_EMULATORS is not "true".
//
// That combination cannot work: the production bucket's CORS allow-list
// (firebase/storage.cors.json) deliberately does not include localhost, so every
// upload and download fails with a bare "CORS error" that says nothing about the
// cause. Everything ELSE in the app - sign-in, Firestore, functions - works fine
// against the live backend from localhost, which is exactly what makes this
// confusing: only the attachment features break.
//
// Detected here rather than left to fail, so the message names the fix.
export const storageNeedsEmulator = Boolean(storage)
  && !usingEmulators
  && typeof window !== "undefined"
  && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(window.location.hostname);

export default app;
