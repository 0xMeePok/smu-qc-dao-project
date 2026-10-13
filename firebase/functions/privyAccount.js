/**
 * Email is the human identifier. The Firebase uid and users/{address} id stay
 * the embedded-wallet address, because postings, proposals and the contracts
 * already key ownership by that address and show it in public. Email and the
 * Privy user id are written here, never by a client.
 *
 * One email, one wallet is Privy's guarantee: Privy keeps one user per email
 * and sign-in accepts only that user's single embedded wallet. A member is not
 * locked out by a lock of our own, so a Privy user recreated for the same email
 * simply arrives as a new, ordinary account. The one privilege keyed by email,
 * the ADMIN_BOOTSTRAP_EMAILS grant, does not rely on that guarantee: it goes
 * only to the first account to hold the email (see firstHolderOfEmail).
 *
 * privyIdentities/{address} holds the binding until onboarding creates the
 * profile, which clients must create without these fields. stampPrivyIdentity
 * copies them on afterwards. A later sign-in writes them directly when the
 * profile already exists.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PRIVY_ID = /^did:privy:[A-Za-z0-9_-]{1,100}$/;

export const PRIVY_IDENTITIES = "privyIdentities";

export class PrivySessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PrivySessionError";
    this.code = code;
  }
}

export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL.test(email)) return null;
  return email;
}

function linkedAccounts(user) {
  return Array.isArray(user?.linked_accounts) ? user.linked_accounts : [];
}

/** The one email Privy verified. Two addresses is a refusal, not a guess. */
export function accountEmail(user) {
  const emails = [...new Set(linkedAccounts(user)
    .filter((account) => account?.type === "email" && typeof account.address === "string")
    .map((account) => normalizeEmail(account.address))
    .filter(Boolean))];
  if (emails.length !== 1) {
    throw new PrivySessionError(
      "failed-precondition",
      emails.length === 0
        ? "Sign in with the email address for this account."
        : "This account has more than one email address. Sign-in cannot choose between them.",
    );
  }
  return emails[0];
}

export function accountPrivyId(user) {
  const id = user?.id;
  if (typeof id !== "string" || !PRIVY_ID.test(id)) {
    throw new PrivySessionError("failed-precondition", "Sign-in could not be confirmed. Try again in a moment.");
  }
  return id;
}

/** Comma-separated list on the functions environment. Empty means nobody is auto-promoted. */
export function bootstrapAdminEmails(env = process.env) {
  return new Set(String(env.ADMIN_BOOTSTRAP_EMAILS || "")
    .split(",")
    .map((part) => normalizeEmail(part))
    .filter(Boolean));
}

function promoteRole(profile, email, adminEmails) {
  const role = profile?.role;
  return adminEmails.has(email) && (role === 0 || role == null);
}

/**
 * True when no other users/{address} carries this email. A second wallet for
 * an administrator's email - a recreated Privy user, or any future change in
 * Privy's one-user-per-email behaviour - is then never promoted automatically;
 * an existing administrator can still grant the role by hand.
 */
async function firstHolderOfEmail(read, db, email, address) {
  const holders = await read(db.collection("users").where("email", "==", email).limit(2));
  return holders.docs.every((doc) => doc.id === address);
}

/**
 * Records this wallet's email and Privy id, or refuses when the wallet's
 * profile already carries a different one. Does not create the profile:
 * onboarding still does that, and the rules forbid the client from writing
 * these fields.
 */
export async function bindPrivyAccount({ db, Timestamp, address, email, privyUserId, adminEmails }) {
  const identityRef = db.collection(PRIVY_IDENTITIES).doc(address);
  const userRef = db.collection("users").doc(address);
  const now = Timestamp.now();
  return db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    const profile = userSnap.exists ? userSnap.data() : null;
    const read = (query) => tx.get(query);
    if (profile?.suspended) {
      throw new PrivySessionError("permission-denied", "This account has been suspended by an administrator.");
    }
    if (profile?.email && profile.email !== email) {
      throw new PrivySessionError("failed-precondition", "This account is already registered to a different email.");
    }
    if (profile?.privyUserId && profile.privyUserId !== privyUserId) {
      throw new PrivySessionError("failed-precondition", "This wallet is already linked to a different sign-in.");
    }
    const grantAdmin = promoteRole(profile, email, adminEmails)
      && await firstHolderOfEmail(read, db, email, address);
    tx.set(identityRef, { address, email, privyUserId, updatedAt: now });
    if (!profile) return { address, email, privyUserId, profileReady: false, roleGranted: grantAdmin };
    const patch = { email, privyUserId, updatedAt: now };
    if (grantAdmin) patch.role = 1;
    tx.set(userRef, patch, { merge: true });
    return { address, email, privyUserId, profileReady: true, role: patch.role ?? profile.role };
  });
}

/**
 * Copies the sign-in binding onto a profile the client just created. A retry
 * writes the same fields again. Role 1 is granted only while the role is still
 * the default 0, only for an email in ADMIN_BOOTSTRAP_EMAILS, and only when no
 * other account already holds that email.
 */
export async function stampUserFromIdentity({ db, Timestamp, address, userData, adminEmails }) {
  const identity = (await db.collection(PRIVY_IDENTITIES).doc(address).get()).data();
  if (!identity?.email || !identity?.privyUserId) return { stamped: false };
  if (userData?.email && userData.email !== identity.email) return { stamped: false };
  if (userData?.privyUserId && userData.privyUserId !== identity.privyUserId) return { stamped: false };
  const patch = {};
  if (userData?.email !== identity.email) patch.email = identity.email;
  if (userData?.privyUserId !== identity.privyUserId) patch.privyUserId = identity.privyUserId;
  if (promoteRole(userData, identity.email, adminEmails)
      && await firstHolderOfEmail((query) => query.get(), db, identity.email, address)) patch.role = 1;
  if (Object.keys(patch).length === 0) return { stamped: false };
  patch.updatedAt = Timestamp.now();
  await db.collection("users").doc(address).set(patch, { merge: true });
  return { stamped: true, ...patch };
}
