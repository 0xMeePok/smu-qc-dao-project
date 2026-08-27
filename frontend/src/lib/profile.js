import { doc, getDoc, serverTimestamp, writeBatch } from "firebase/firestore";
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

// The public face of a profile - name and organisation only. Split out of /users
// because Firestore rules cannot filter which FIELDS a read returns: `allow get` is
// all-or-nothing per document, so the only way to publish two fields while keeping
// `role`, `stats` and the timestamps private is to keep them in different documents.
// See the publicProfiles block in firebase/firestore.rules.
function publicProfileRef(address) {
  return doc(db, "publicProfiles", address.toLowerCase());
}

function toPublicProfile(profile) {
  return {
    address: profile.address,
    fullName: profile.fullName,
    organisation: profile.organisation,
    biography: profile.biography,
    expertise: profile.expertise,
  };
}

/**
 * Reads the signed-in user's OWN profile. /users is readable only by its owner, so
 * this will be denied for any other address - use findPublicProfileByAddress for
 * attributing published work to someone else.
 */
export async function findProfileByAddress(address) {
  requireFirebase();
  const snapshot = await getDoc(profileRef(address));
  return snapshot.exists() ? snapshot.data() : null;
}
export async function findPublicProfileByAddress(address) {
  requireFirebase();
  const snapshot = await getDoc(publicProfileRef(address));
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
  const expertise = Array.isArray(form.expertise)
    ? form.expertise.map((item) => item.trim()).filter(Boolean)
    : [];
  const profile = {
    address: lower,
    fullName: form.fullName.trim(),
    organisation: form.organisation.trim(),
    biography: (form.biography ?? "").trim(),
    expertise,
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

  // Batched so the private profile and its public face are created in one atomic
  // commit. Two sequential setDoc calls could leave an account half-created if the
  // second failed - either a private profile nobody can attribute work to, or a
  // public name with no account behind it.
  const batch = writeBatch(db);
  batch.set(profileRef(lower), profile);
  batch.set(publicProfileRef(lower), toPublicProfile(profile));
  await batch.commit();

  return profile;
}
