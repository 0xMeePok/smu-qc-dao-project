import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { db } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { OnboardingError } from "./errors.js";
import { validateOnboarding } from "./validation.js";
import { initialStats } from "./stats.js";
import { EXPECTED_CHAIN_ID } from "./chain.js";
import { DEFAULT_ROLE } from "./roles.js";

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
    // The real role choice happens on the role-selection screen right after this;
    // see the comment on validateOnboarding for why it is not asked here too.
    role: DEFAULT_ROLE,
    chainId: EXPECTED_CHAIN_ID,
    stats: initialStats,
    // Safe to assert: this write is only possible with a uid the server minted
    // after verifying a signature from this exact address.
    walletVerified: true,
    termsAcceptedAt: serverTimestamp(),
    termsVersion: TERMS_VERSION,
    onboardingComplete: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  await setDoc(profileRef(lower), profile);
  return profile;
}

export async function updateRole({ address, role }) {
  requireFirebase();
  await updateDoc(profileRef(address), {
    role,
    onboardingComplete: true,
    updatedAt: serverTimestamp(),
  });
}
