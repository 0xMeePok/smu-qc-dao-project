import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { createPublicClient, http, verifyMessage } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { randomBytes } from "node:crypto";

initializeApp();

const db = getFirestore();
const NONCE_COLLECTION = "siweNonces";
const NONCE_TTL_MS = 5 * 60 * 1000;

// There is deliberately no per-address cooldown any more. It was an attempt to limit
// how often a pending nonce could be overwritten; getSiweNonce now never overwrites
// one at all, so repeat calls for an address are harmless AND cheaper than before -
// they resolve inside the read half of a transaction and write nothing. Reinstating a
// cooldown would only add a way to refuse legitimate users.

// Hard ceiling on concurrent instances. Bounds the worst-case cost and blast radius
// of a volumetric flood (many distinct addresses, one call each, so per-address
// idempotency does not help) to a fixed number regardless of how much traffic
// arrives - once instances are saturated, Cloud Run queues or fails fast rather than
// autoscaling without limit. This adds no latency to normal traffic; a handful of
// concurrent sign-ins never gets close to it.
const NONCE_MAX_INSTANCES = 10;

// Must match FUNCTIONS_REGION in frontend/src/lib/firebase.js. Must ALSO match the
// Firestore database's own location (see `firebase firestore:databases:get
// "(default)" --project <id>`, and firebase/README.md for how to set it on a fresh
// project) - getSiweNonce does two sequential Firestore round trips per call (a read
// then a write), and every one of them crosses regions if this doesn't match. That
// was previously true here (functions in asia-southeast1, Firestore left on its
// default nam5/US location) and measured out to ~400ms-1.3s per sign-in from cross-
// Pacific latency alone, dwarfing everything else on the critical path. 
const REGION = "asia-southeast1";

const publicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(process.env.ARBITRUM_SEPOLIA_RPC_URL || undefined),
});

function normaliseAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new HttpsError("invalid-argument", "A valid wallet address is required.");
  }
  return value.toLowerCase();
}

/**
 * Builds the exact string the user signs.
 *
 * This lives ONLY on the server. The client never supplies a message: it asks for a
 * nonce, receives the finished message, and signs it verbatim. If the client could
 * choose the text, it could get a user to sign something harmless here and replay
 * that signature somewhere it means much more.
 */
function buildMessage({ address, nonce, issuedAt, domain }) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to SMU QC DAO. This proves you control this wallet.",
    "It authorises no transaction, moves no funds and costs no gas.",
    "",
    `URI: https://${domain}`,
    "Version: 1",
    `Chain ID: ${arbitrumSepolia.id}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

// The SIWE `domain` field binds a signature to ONE site. Its whole purpose is to
// make a signature collected on one origin useless on another.
// Now the domain is server-controlled: an Origin is only honoured when it appears on
// an allow-list this deployment owns, and anything else is refused outright.
const SIWE_DOMAIN_FALLBACK = "smu-qc-dao";

// Cloud Functions sets GCLOUD_PROJECT; Firebase Hosting always provisions
// <project>.web.app and <project>.firebaseapp.com. Deriving them means the common
// deployment needs no configuration and still keeps the message accurate for real
// users, instead of a hardcoded guess that rots the moment the project is renamed.
function defaultAllowedHosts() {
  const projectId = (process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "").trim();
  return projectId ? [`${projectId}.web.app`, `${projectId}.firebaseapp.com`] : [];
}

// Dev origins are allowed ONLY under the emulator. Allow-listing localhost in
// production would reopen the hole: an attacker would forge `Origin:
// localhost:5173` and be handed a signable message again.
const DEV_HOSTS = ["localhost:5173", "127.0.0.1:5173"];

function canonicalDomain() {
  return (process.env.SIWE_DOMAIN || "").trim().toLowerCase()
    || defaultAllowedHosts()[0]
    || SIWE_DOMAIN_FALLBACK;
}

function allowedHosts() {
  const configured = (process.env.SIWE_ALLOWED_HOSTS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const hosts = [canonicalDomain(), ...defaultAllowedHosts(), ...configured];
  if (process.env.FUNCTIONS_EMULATOR === "true") hosts.push(...DEV_HOSTS);

  return new Set(hosts.filter(Boolean));
}

function resolveDomain(request) {
  const origin = request.rawRequest?.headers?.origin;

  // No Origin at all means this cannot be a browser (curl, a server, the test
  // suite). There is nothing to validate, so the message names this deployment -
  // which is the truthful answer and the one a phishing victim most needs to see.
  if (!origin) return canonicalDomain();

  let host;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    throw new HttpsError("permission-denied", "Sign-in is not available from this origin.");
  }

  // Fails CLOSED. An unrecognised Origin is a positive signal that a browser on a
  // site we do not serve is asking for a signable message, so it is refused rather
  // than quietly downgraded. Note this is deliberately NOT the shape of a check
  // that skips itself when the env var is unset - a security control that does
  // nothing until someone remembers to configure it is one that will be forgotten
  // exactly once, in production.
  if (!allowedHosts().has(host)) {
    throw new HttpsError("permission-denied", "Sign-in is not available from this origin.");
  }

  return host;
}

/**
 * Step 1 of sign-in. Issues a single-use nonce and returns the message to sign.
 * The nonce document is written with the Admin SDK, so it is unreachable from any
 * browser: firestore.rules denies the whole collection.
 */
export const getSiweNonce = onCall(
  { region: REGION, maxInstances: NONCE_MAX_INSTANCES },
  async (request) => {
    const address = normaliseAddress(request.data?.address);
    const ref = db.collection(NONCE_COLLECTION).doc(address);

    const domain = resolveDomain(request);

    // IDEMPOTENT while a nonce is pending: an unexpired, unconsumed nonce is
    // returned as-is rather than replaced.
    //
    // The previous version overwrote any nonce older than a 3-second cooldown, which
    // made login griefable by anyone who knew a wallet address (they are public).
    // Requesting a nonce for a victim every few seconds replaced the message they
    // were part-way through signing, so their signature no longer matched anything
    // stored and sign-in failed - repeatably, for as long as the attacker kept
    // polling. Simply refusing while one is pending would be worse still: a single
    // attacker request would then lock that address out for the full 5-minute TTL.
    //
    // Returning the pending nonce removes the vector entirely, because nothing is
    // ever invalidated. An attacker calling this for someone else's address learns
    // only the message that address already had - which was always going to be shown
    // to a user, and cannot be signed without their key.
    //
    // Wrapped in a transaction so two concurrent calls for one address cannot both
    // decide the record is absent and write different nonces, which would have left
    // whichever user signed the losing message unable to verify.
    const issued = await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);

      if (snapshot.exists) {
        const data = snapshot.data() ?? {};
        // Timestamps are read defensively: a malformed record must be replaced, never
        // treated as a pending nonce that can never expire and so blocks the address
        // permanently.
        const expiresAtMs = typeof data.expiresAt?.toMillis === "function"
          ? data.expiresAt.toMillis()
          : null;
        const stillPending = data.consumed === false
          && typeof data.nonce === "string"
          && typeof data.issuedAt === "string"
          && expiresAtMs !== null
          && expiresAtMs > Date.now();

        // Reissue when the pending nonce was minted for a different origin, so a
        // message is never handed to one allowed origin bearing another's name.
        if (stillPending && data.domain === domain) {
          return { nonce: data.nonce, issuedAt: data.issuedAt, domain: data.domain };
        }
      }

      const fresh = {
        nonce: randomBytes(16).toString("hex"),
        issuedAt: new Date().toISOString(),
        domain,
      };

      tx.set(ref, {
        ...fresh,
        address,
        consumed: false,
        expiresAt: Timestamp.fromMillis(Date.now() + NONCE_TTL_MS),
        createdAt: Timestamp.now(),
      });

      return fresh;
    });

    return {
      message: buildMessage({ address, ...issued }),
      nonce: issued.nonce,
      issuedAt: issued.issuedAt,
    };
  },
);

/**
 * Step 2 of sign-in. Verifies the signature against the message this server issued,
 * burns the nonce, and mints a Firebase custom token whose uid IS the wallet address.
 *
 * That uid is the whole security model: firestore.rules only ever has to check
 * `request.auth.uid == address`, and a uid can exist only if this function verified a
 * signature first. Nothing the browser does can forge one.
 */
export const verifySiweSignature = onCall({ region: REGION }, async (request) => {
  const address = normaliseAddress(request.data?.address);
  const signature = request.data?.signature;

  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    throw new HttpsError("invalid-argument", "A signature is required.");
  }

  const ref = db.collection(NONCE_COLLECTION).doc(address);

  // READ ONLY. The nonce is not touched until the signature is known to be good.
  //
  // This used to claim the nonce inside a transaction BEFORE verifying, then undo
  // that with a second write when verification failed. Two problems: a bogus
  // signature briefly marked a live nonce consumed, so a legitimate signature
  // arriving inside that window was rejected as already-used; and if the undo
  // failed, or the instance died between the two writes, the nonce stayed burned
  // and the real owner was locked out until they started again.
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    throw new HttpsError("failed-precondition", "No sign-in request is pending for this wallet. Start again.");
  }

  const record = snapshot.data() ?? {};
  const expiresAtMs = typeof record.expiresAt?.toMillis === "function"
    ? record.expiresAt.toMillis()
    : null;

  if (record.consumed) {
    throw new HttpsError("failed-precondition", "That sign-in request was already used. Start again.");
  }
  if (expiresAtMs === null || typeof record.nonce !== "string" || typeof record.issuedAt !== "string") {
    throw new HttpsError("failed-precondition", "That sign-in request is no longer valid. Start again.");
  }
  if (expiresAtMs < Date.now()) {
    throw new HttpsError("deadline-exceeded", "That sign-in request expired. Start again.");
  }

  // Rebuilt from what the server stored, never from anything the client sent.
  const message = buildMessage({
    address,
    nonce: record.nonce,
    issuedAt: record.issuedAt,
    domain: record.domain,
  });

  let valid = false;
  try {
    valid = await verifyMessage({ address, message, signature, client: publicClient });
  } catch {
    valid = false;
  }

  if (!valid) {
    // No write happened, so a forged signature costs the legitimate holder nothing:
    // their already-signed message still matches this same nonce.
    throw new HttpsError("permission-denied", "That signature does not match this wallet.");
  }

  // Only now is the nonce spent, atomically and only if it is still the SAME record
  // the signature was checked against.
  //
  // Re-reading `consumed` alone is not enough. The nonce read above could expire
  // between that read and this write, letting getSiweNonce mint a replacement - and
  // this transaction would then consume the NEW nonce on the strength of a signature
  // over the OLD one. Comparing the nonce value closes that, and re-checking expiry
  // stops a nonce that lapsed mid-verification from being spent at all.
  await db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    const data = current.exists ? current.data() ?? {} : null;

    if (!data || data.consumed || data.nonce !== record.nonce) {
      throw new HttpsError("failed-precondition", "That sign-in request was already used. Start again.");
    }

    const currentExpiry = typeof data.expiresAt?.toMillis === "function"
      ? data.expiresAt.toMillis()
      : null;
    if (currentExpiry === null || currentExpiry < Date.now()) {
      throw new HttpsError("deadline-exceeded", "That sign-in request expired. Start again.");
    }

    tx.update(ref, { consumed: true, consumedAt: Timestamp.now() });
  });

  // Check if account has been administratively suspended
  const userProfileSnap = await db.collection("users").doc(address).get();
  if (userProfileSnap.exists && userProfileSnap.data()?.suspended) {
    throw new HttpsError("permission-denied", "This account has been suspended by an administrator.");
  }

  const token = await getAuth().createCustomToken(address, {
    wallet: address,
    chainId: arbitrumSepolia.id,
  });

  return { token, address };
});

/**
 * Validates that the caller is an authenticated administrator (role == 1) and not suspended.
 */
async function requireAdmin(request) {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  const userDoc = await db.collection("users").doc(uid.toLowerCase()).get();
  if (!userDoc.exists || userDoc.data()?.role !== 1) {
    throw new HttpsError("permission-denied", "Administrator privilege required.");
  }
  if (userDoc.data()?.suspended) {
    throw new HttpsError("permission-denied", "This administrator account is suspended.");
  }
  return { uid: uid.toLowerCase(), adminUser: userDoc.data() };
}

/**
 * Admin: List platform users with search, filtering, and pagination.
 */
export const adminListUsers = onCall({ region: REGION }, async (request) => {
  await requireAdmin(request);

  const {
    page = 1,
    pageSize = 20,
    search = "",
    roleFilter = null,
    orgFilter = "",
  } = request.data ?? {};

  let usersQuery = db.collection("users");
  if (typeof roleFilter === "number" && (roleFilter === 0 || roleFilter === 1)) {
    usersQuery = usersQuery.where("role", "==", roleFilter);
  }

  const snapshot = await usersQuery.get();
  let users = snapshot.docs.map((docSnap) => {
    const data = docSnap.data();
    return {
      address: docSnap.id,
      fullName: data.fullName || "",
      organisation: data.organisation || "",
      role: typeof data.role === "number" ? data.role : 0,
      suspended: Boolean(data.suspended),
      createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : null,
      updatedAt: data.updatedAt?.toDate ? data.updatedAt.toDate().toISOString() : null,
    };
  });
  if (typeof orgFilter === "string" && orgFilter.trim().length > 0) {
    const orgLower = orgFilter.trim().toLowerCase();
    users = users.filter((u) => u.organisation.toLowerCase().includes(orgLower));
  }
  if (typeof search === "string" && search.trim().length > 0) {
    const searchLower = search.trim().toLowerCase();
    users = users.filter((u) =>
      u.fullName.toLowerCase().includes(searchLower) ||
      u.address.toLowerCase().includes(searchLower) ||
      u.organisation.toLowerCase().includes(searchLower),
    );
  }

  users.sort((a, b) => a.fullName.localeCompare(b.fullName) || a.address.localeCompare(b.address));

  const total = users.length;
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safePageSize = Math.max(1, Math.min(100, parseInt(pageSize, 10) || 20));
  const startIndex = (safePage - 1) * safePageSize;
  const paginatedUsers = users.slice(startIndex, startIndex + safePageSize);

  return {
    users: paginatedUsers,
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.ceil(total / safePageSize) || 1,
  };
});

/**
 * Admin: Change a user's role assignment with written reason and audit recording.
 */
export const adminChangeRole = onCall({ region: REGION }, async (request) => {
  const { uid: actorUid, adminUser } = await requireAdmin(request);

  const targetAddress = normaliseAddress(request.data?.targetAddress);
  const newRole = request.data?.newRole;
  const reason = request.data?.reason;

  if (typeof newRole !== "number" || (newRole !== 0 && newRole !== 1)) {
    throw new HttpsError("invalid-argument", "Valid role (0 for User, 1 for Admin) is required.");
  }
  if (typeof reason !== "string" || reason.trim().length < 5 || reason.length > 500) {
    throw new HttpsError("invalid-argument", "A reason between 5 and 500 characters is required.");
  }
  if (targetAddress === actorUid) {
    throw new HttpsError("failed-precondition", "Administrators cannot modify their own role assignment.");
  }

  const targetRef = db.collection("users").doc(targetAddress);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) {
    throw new HttpsError("not-found", "Target user profile not found.");
  }

  const targetData = targetSnap.data();
  const previousRole = typeof targetData.role === "number" ? targetData.role : 0;
  if (previousRole === newRole) {
    throw new HttpsError("failed-precondition", "Target user already possesses this role assignment.");
  }

  await targetRef.update({
    role: newRole,
    updatedAt: Timestamp.now(),
  });

  const auditEntry = {
    type: "role_change",
    action: "ROLE_CHANGE",
    actor: actorUid,
    actorName: adminUser.fullName || actorUid,
    targetAddress,
    targetName: targetData.fullName || targetAddress,
    previousRole,
    newRole,
    reason: reason.trim(),
    timestamp: Timestamp.now(),
    createdAt: Timestamp.now(),
  };
  await db.collection("audits").add(auditEntry);

  return {
    success: true,
    targetAddress,
    previousRole,
    newRole,
    updatedAt: new Date().toISOString(),
  };
});

/**
 * Admin: Suspend or reinstate a user account with written reason and audit recording.
 */
export const adminSetSuspended = onCall({ region: REGION }, async (request) => {
  const { uid: actorUid, adminUser } = await requireAdmin(request);

  const targetAddress = normaliseAddress(request.data?.targetAddress);
  const suspended = request.data?.suspended;
  const reason = request.data?.reason;

  if (typeof suspended !== "boolean") {
    throw new HttpsError("invalid-argument", "A boolean suspended flag is required.");
  }
  if (typeof reason !== "string" || reason.trim().length < 5 || reason.length > 500) {
    throw new HttpsError("invalid-argument", "A reason between 5 and 500 characters is required.");
  }
  if (targetAddress === actorUid && suspended) {
    throw new HttpsError("failed-precondition", "Administrators cannot suspend their own account.");
  }

  const targetRef = db.collection("users").doc(targetAddress);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) {
    throw new HttpsError("not-found", "Target user profile not found.");
  }

  const targetData = targetSnap.data();
  const currentSuspended = Boolean(targetData.suspended);
  if (currentSuspended === suspended) {
    throw new HttpsError(
      "failed-precondition",
      suspended ? "User account is already suspended." : "User account is not currently suspended.",
    );
  }

  await targetRef.update({
    suspended,
    updatedAt: Timestamp.now(),
  });

  if (suspended) {
    try {
      await getAuth().revokeRefreshTokens(targetAddress);
    } catch (err) {
      if (err?.code !== "auth/user-not-found") {
        console.error(`Failed to revoke refresh tokens for ${targetAddress}:`, err);
      }
    }
  }

  const auditEntry = {
    type: "suspension_change",
    action: suspended ? "USER_SUSPENDED" : "USER_REINSTATED",
    actor: actorUid,
    actorName: adminUser.fullName || actorUid,
    targetAddress,
    targetName: targetData.fullName || targetAddress,
    previousState: currentSuspended,
    newState: suspended,
    reason: reason.trim(),
    timestamp: Timestamp.now(),
    createdAt: Timestamp.now(),
  };
  await db.collection("audits").add(auditEntry);

  return {
    success: true,
    targetAddress,
    suspended,
    updatedAt: new Date().toISOString(),
  };
});

