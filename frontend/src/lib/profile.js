import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { OnboardingError } from "./errors.js";
import { validateOnboarding } from "./validation.js";
import { initialStats } from "./stats.js";
import { EXPECTED_CHAIN_ID } from "./chain.js";
import { ROLE_USER } from "./roles.js";

export const TERMS_VERSION = "2026-08-24";

// Profiles are keyed by lowercase wallet address, which is also the Firebase uid
// minted by verifySiweSignature. Rules only have to check that the two match.
function profileRef(address) {
  return doc(db, "users", address.toLowerCase());
}

export async function findProfileByAddress(address) {
  requireFirebase();
  const snapshot = await getDoc(profileRef(address));
  return snapshot.exists() ? snapshot.data() : null;
}

export async function createProfile({ form, address }) {
  requireFirebase();

  const errors = validateOnboarding(form, address);
  const firstField = Object.keys(errors)[0];
  if (firstField) {
    throw new OnboardingError(errors[firstField], { field: firstField });
  }

  const lower = address.toLowerCase();
  const profile = {
    address: lower,
    fullName: form.fullName.trim(),
    organisation: form.organisation.trim(),
    // Every account starts as a normal user. Nothing in the client can write 1
    // here or later: firebase/firestore.rules fixes this to 0 on create and makes
    // it immutable on every update, so becoming an administrator is only ever done
    // by hand, directly in Firestore, by someone with console access.
    role: ROLE_USER,
    chainId: EXPECTED_CHAIN_ID,
    stats: initialStats,
    // Safe to assert: this write is only possible with a uid the server minted
    // after verifying a signature from this exact address.
    walletVerified: true,
    termsAcceptedAt: serverTimestamp(),
    termsVersion: TERMS_VERSION,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  await setDoc(profileRef(lower), profile);
  return profile;
}
