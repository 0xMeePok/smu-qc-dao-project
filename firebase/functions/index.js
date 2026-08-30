import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { createPublicClient, http, verifyMessage } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { createHash, randomBytes } from "node:crypto";
import { resolveDomain } from "./siweOrigin.js";
import {
  SESSION_REVOCATIONS_COLLECTION,
  applyRoleChangeTransaction,
  applySuspensionChangeTransaction,
  finalizeSuspensionRevocation,
  isAuthTimeRevoked,
  writeSessionCutoff,
} from "./adminActions.js";

initializeApp();

const db = getFirestore();
const NONCE_COLLECTION = "siweNonces";
const NONCE_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_COLLECTION = "siweRateLimits";
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_PER_SOURCE = 100;
const RATE_LIMIT_GLOBAL = 1000;

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
  const scheme = domain.startsWith("localhost:") || domain.startsWith("127.0.0.1:")
    ? "http"
    : "https";
  return createSiweMessage({
    address,
    chainId: arbitrumSepolia.id,
    domain,
    issuedAt: new Date(issuedAt),
    nonce,
    scheme,
    statement: "Sign in to SMU QC DAO. This proves wallet control and authorises no transaction.",
    uri: `${scheme}://${domain}`,
    version: "1",
  });
}

function quotaCounter(snapshot, nowMs) {
  if (!snapshot.exists) return { count: 0, windowStartedAtMs: nowMs };
  const data = snapshot.data() ?? {};
  const started = typeof data.windowStartedAt?.toMillis === "function"
    ? data.windowStartedAt.toMillis()
    : 0;
  if (started <= 0 || nowMs - started >= RATE_LIMIT_WINDOW_MS) {
    return { count: 0, windowStartedAtMs: nowMs };
  }
  return {
    count: Number.isInteger(data.count) && data.count >= 0 ? data.count : 0,
    windowStartedAtMs: started,
  };
}

async function enforceNonceQuota(request) {
  const emulatorTestSource = process.env.FUNCTIONS_EMULATOR === "true"
    ? request.rawRequest?.headers?.["x-emulator-test-source"]
    : null;
  const source = emulatorTestSource
    || request.rawRequest?.ip
    || request.rawRequest?.socket?.remoteAddress
    || "unknown";
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const globalRef = db.collection(RATE_LIMIT_COLLECTION).doc("global");
  const sourceRef = db.collection(RATE_LIMIT_COLLECTION).doc(`source_${sourceHash}`);
  const nowMs = Date.now();

  await db.runTransaction(async (tx) => {
    const [globalSnapshot, sourceSnapshot] = await Promise.all([
      tx.get(globalRef),
      tx.get(sourceRef),
    ]);
    const global = quotaCounter(globalSnapshot, nowMs);
    const perSource = quotaCounter(sourceSnapshot, nowMs);

    if (global.count >= RATE_LIMIT_GLOBAL || perSource.count >= RATE_LIMIT_PER_SOURCE) {
      throw new HttpsError(
        "resource-exhausted",
        "Too many sign-in requests. Wait one minute and try again.",
      );
    }

    const expiresAt = Timestamp.fromMillis(nowMs + RATE_LIMIT_WINDOW_MS * 2);
    tx.set(globalRef, {
      count: global.count + 1,
      windowStartedAt: Timestamp.fromMillis(global.windowStartedAtMs),
      expiresAt,
    });
    tx.set(sourceRef, {
      count: perSource.count + 1,
      windowStartedAt: Timestamp.fromMillis(perSource.windowStartedAtMs),
      expiresAt,
    });
  });
}

/**
 * Step 1 of sign-in. Issues a single-use nonce and returns the message to sign.
 * The nonce document is written with the Admin SDK, so it is unreachable from any
 * browser: firestore.rules denies the whole collection.
 */
export const getSiweNonce = onCall(
  {
    region: REGION,
    maxInstances: NONCE_MAX_INSTANCES,
    enforceAppCheck: process.env.FUNCTIONS_EMULATOR !== "true",
    // Diagnostic: isolate whether limited-use consumption is the 401. App Check
    // is still required; tokens are no longer treated as single-use.
    consumeAppCheckToken: false,
  },
  async (request) => {
    const address = normaliseAddress(request.data?.address);
    const ref = db.collection(NONCE_COLLECTION).doc(address);

    const domain = resolveDomain(request);
    await enforceNonceQuota(request);

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

  const parsedMessage = parseSiweMessage(message);
  const expectedScheme = record.domain.startsWith("localhost:")
    || record.domain.startsWith("127.0.0.1:")
    ? "http"
    : "https";
  const conformsToSiwe = validateSiweMessage({
    address,
    domain: record.domain,
    message: parsedMessage,
    nonce: record.nonce,
    scheme: expectedScheme,
  })
    && parsedMessage.chainId === arbitrumSepolia.id
    && parsedMessage.version === "1"
    && parsedMessage.uri === `${expectedScheme}://${record.domain}`
    && parsedMessage.issuedAt?.toISOString() === record.issuedAt;

  if (!conformsToSiwe) {
    throw new HttpsError("failed-precondition", "That sign-in request is malformed. Start again.");
  }

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
 * Invalidates every refresh token for the current wallet before the browser clears
 * its local Firebase persistence. The Firestore marker blocks already-issued ID
 * tokens immediately; Firebase revocation blocks those sessions from refreshing.
 */
export const revokeOwnSessions = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid?.toLowerCase();
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required.");

  const revokedAfterEpoch = Math.floor(Date.now() / 1000);
  const userRef = db.collection("users").doc(uid);
  const revocationRef = db.collection(SESSION_REVOCATIONS_COLLECTION).doc(uid);
  const auditRef = db.collection("audits").doc();
  await db.runTransaction(async (tx) => {
    const user = await tx.get(userRef);
    const changedAt = Timestamp.now();
    writeSessionCutoff(tx, revocationRef, revokedAfterEpoch, changedAt);
    if (user.exists) {
      tx.update(userRef, {
        sessionsValidAfterEpoch: revokedAfterEpoch,
        updatedAt: changedAt,
      });
    }
    tx.set(auditRef, {
      type: "session_revocation",
      action: "SESSIONS_REVOKED_BY_USER",
      actor: uid,
      targetAddress: uid,
      revokedAfterEpoch,
      timestamp: changedAt,
      createdAt: changedAt,
    });
  });

  try {
    await getAuth().revokeRefreshTokens(uid);
  } catch (error) {
    if (error?.code !== "auth/user-not-found") {
      throw new HttpsError(
        "unavailable",
        "Server credential revocation is pending. Retry sign out.",
      );
    }
  }

  return { success: true, scope: "all-devices", revokedAfterEpoch };
});

/**
 * Validates that the caller is an authenticated administrator (role == 1) and not suspended.
 */
async function requireAdmin(request) {
  const uid = request.auth?.uid?.toLowerCase();
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists || userDoc.data()?.role !== 1) {
    throw new HttpsError("permission-denied", "Administrator privilege required.");
  }
  if (userDoc.data()?.suspended) {
    throw new HttpsError("permission-denied", "This administrator account is suspended.");
  }
  const authTime = request.auth?.token?.auth_time ?? 0;
  const validAfter = userDoc.data()?.sessionsValidAfterEpoch;
  const revocation = await db.collection(SESSION_REVOCATIONS_COLLECTION).doc(uid).get();
  const revocationAfter = revocation.exists ? revocation.data()?.sessionsValidAfterEpoch : null;
  if (isAuthTimeRevoked(authTime, validAfter, revocationAfter)) {
    throw new HttpsError("unauthenticated", "This session was revoked. Sign in again.");
  }
  return { uid, adminUser: userDoc.data() };
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
  const auditRef = db.collection("audits").doc();
  let previousRole;
  await db.runTransaction(async (tx) => {
    previousRole = await applyRoleChangeTransaction(tx, {
      targetRef,
      auditRef,
      actorUid,
      adminUser,
      targetAddress,
      newRole,
      reason,
      timestamp: Timestamp.now(),
    });
  });

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
  const revocationRef = db.collection(SESSION_REVOCATIONS_COLLECTION).doc(targetAddress);
  const auditRef = db.collection("audits").doc();
  await db.runTransaction(async (tx) => {
    await applySuspensionChangeTransaction(tx, {
      targetRef,
      auditRef,
      revocationRef,
      actorUid,
      adminUser,
      targetAddress,
      suspended,
      reason,
      timestamp: Timestamp.now(),
      revokedAfterEpoch: Math.floor(Date.now() / 1000),
    });
  });

  if (suspended) {
    await finalizeSuspensionRevocation({
      db,
      Timestamp,
      targetRef,
      auditRef,
      targetAddress,
      revokeRefreshTokens: (uid) => getAuth().revokeRefreshTokens(uid),
    });
  }

  return {
    success: true,
    targetAddress,
    suspended,
    revocationStatus: suspended ? "succeeded" : "not-required",
    updatedAt: new Date().toISOString(),
  };
});
