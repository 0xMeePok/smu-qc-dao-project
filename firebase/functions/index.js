import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentUpdated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { createPublicClient, http, verifyMessage } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { createHash, randomBytes } from "node:crypto";
import { resolveDomain } from "./siweOrigin.js";
import { registerModerationCallables } from "./moderationFunctions.js";
import { registerMatchingNotificationFunctions } from "./matchingNotifications.js";
import {
  SESSION_REVOCATIONS_COLLECTION,
  applyRoleChangeTransaction,
  applySuspensionChangeTransaction,
  finalizeSuspensionRevocation,
  isAuthTimeRevoked,
  writeSessionCutoff,
} from "./adminActions.js";
import { sweepOrphanedAttachments } from "./attachmentSweeper.js";
import { affectsMetrics, syncMetricContribution, refreshOpportunityMetrics } from "./opportunityMetrics.js";
import { AUDIT_JOBS, enqueueProposalAudit, recoverProposalAudit, verifyMinedProposal } from "./proposalAuditRecovery.js";
import { prepareStoredProposal } from "./proposalAuditPayload.js";
import { recordProposalRevision } from "./proposalRevisions.js";
import { recordOpportunityRevision } from "./opportunityRevisions.js";
import { EXPIRY_REASONS } from "./opportunityExpiry.js";
import { EXPIRY_SOURCES, expireOpportunity, lapseDueOpportunities } from "./opportunityExpiryService.js";
import { verifyPublication } from "./publication.js";
import { getMockMatching as readMockMatching, fundMockProposal as contributeMockFunding,
  selectMockProposal as chooseMockProposal, confirmMockProposal as acceptMockProposal,
  getMockFundingPortfolio as readMockFundingPortfolio, sweepExpiredMockMatches,
  declineMockProposal as rejectMockProposal, completeMockEvaluation as finishMockEvaluation, forceExpireMockMatch as forceExpireMockWindow } from "./matching.js";
import { createComment as writeComment, editComment as amendComment,
  deleteComment as removeComment } from "./comments.js";
import { listPostedProposals as listPostedProposalsForProblem } from "./moderation.js";
import { listEvaluatorQueue as evaluatorQueue, listMyProposals } from "./proposalQueues.js";
import { matchesUploadReservation, reserveRecord, reserveUpload, releaseDeletedUpload, resourceKey,
  uploadObjectPath, uploadReservationKey, validateResource } from "./resourceQuotas.js";

initializeApp();

const db = getFirestore();
const NONCE_COLLECTION = "siweNonces";
const NONCE_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_COLLECTION = "siweRateLimits";
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_PER_SOURCE = 100;
const RATE_LIMIT_GLOBAL = 1000;

function isoTimestamp(value) {
  if (value == null || value === "") return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

function attachmentMetadata(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.map((item) => ({
    id: item?.id ?? "",
    name: item?.name ?? "",
    size: Number(item?.size ?? 0),
    contentType: item?.contentType || "application/pdf",
  }));
}

/** Parent listing fields the admin proposal queue needs to render and re-hash an audit receipt. */
function serializeOpportunityForAdmin(id, data) {
  if (!data) return null;
  return {
    id,
    ownerId: data.ownerId || "",
    organisation: data.organisation || "",
    title: data.title || "",
    status: data.status || "",
    opportunityType: data.opportunityType || null,
    businessContext: data.businessContext || "",
    summary: data.summary || "",
    currentApproach: data.currentApproach || "",
    currentLimitations: data.currentLimitations || "",
    expectedOutcome: data.expectedOutcome || "",
    successCriteria: data.successCriteria || "",
    dataAvailability: data.dataAvailability || "",
    fundingThesis: data.fundingThesis || "",
    eligibilityNotes: data.eligibilityNotes || "",
    categories: Array.isArray(data.categories) ? data.categories : [],
    tags: Array.isArray(data.tags) ? data.tags : [],
    amount: data.amount ?? null,
    currency: data.currency || "",
    expiresAt: isoTimestamp(data.expiresAt),
    createdAt: isoTimestamp(data.createdAt),
    updatedAt: isoTimestamp(data.updatedAt),
    attachments: attachmentMetadata(data.attachments),
    audit: data.audit || null,
  };
}

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

// Must match FUNCTIONS_REGION in frontend/src/lib/firebase.js and the Firestore
// database location. Otherwise every sign-in crosses regions.
const REGION = "asia-southeast1";

export const { notifyMatchingEvent, resumeMatchingNotificationDelivery, remindNearingApprovalWindows } = registerMatchingNotificationFunctions({ db, region: REGION });

async function syncOpportunityMetrics(event, collectionName, recordId) {
  if (!affectsMetrics(collectionName, event)) return;
  await syncMetricContribution({ db, collectionName, recordId, updatedAt: Timestamp.now() });
}

async function syncProblemOpportunityMetrics(event) {
  if (event.data?.before?.exists && event.data?.after?.exists
      && event.data.before.data().amount === event.data.after.data().amount) return;
  await refreshOpportunityMetrics({
    db,
    problemId: event.params.problemId,
    updatedAt: Timestamp.now(),
  });
}

// Proposal bodies stay private. These triggers publish only counts and aggregate
// funding progress for the marketplace cards and posting detail page.
export const syncProposalOpportunityMetrics = onDocumentWritten(
  { document: "proposals/{proposalId}", region: REGION, maxInstances: 5, retry: true },
  (event) => syncOpportunityMetrics(event, "proposals", event.params.proposalId),
);

export const syncFundingOpportunityMetrics = onDocumentWritten(
  { document: "funding/{fundId}", region: REGION, maxInstances: 5, retry: true },
  (event) => syncOpportunityMetrics(event, "funding", event.params.fundId),
);

// The requested amount is the denominator for funding progress. Rebuild when the
// opportunity itself changes as well, and remove the projection when it is deleted.
export const syncProblemMarketplaceMetrics = onDocumentWritten(
  { document: "problems/{problemId}", region: REGION, maxInstances: 5, retry: true },
  syncProblemOpportunityMetrics,
);

const publicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(process.env.ARBITRUM_SEPOLIA_RPC_URL || undefined),
});

async function requireMember(request) {
  const uid = request.auth?.uid;
  if (!/^0x[0-9a-f]{40}$/.test(uid ?? "")) throw new HttpsError("unauthenticated", "Sign in with your wallet.");
  const [profile, cutoff, maintenance] = await Promise.all([
    db.collection("users").doc(uid).get(), db.collection(SESSION_REVOCATIONS_COLLECTION).doc(uid).get(),
    db.collection("maintenanceState").doc("registryCutover").get(),
  ]);
  if (maintenance.data()?.active) throw new HttpsError("unavailable", "Registry maintenance is in progress.");
  if (!profile.exists || profile.data().suspended) throw new HttpsError("permission-denied", "Complete your active member profile first.");
  if (isAuthTimeRevoked(request.auth.token.auth_time ?? 0,
    profile.data().sessionsValidAfterEpoch, cutoff.data()?.sessionsValidAfterEpoch)) {
    throw new HttpsError("unauthenticated", "Sign in again to continue.");
  }
  return uid;
}

const MEMBER_CALL_OPTIONS = { region: REGION, maxInstances: 5,
  enforceAppCheck: process.env.FUNCTIONS_EMULATOR !== "true" };

export const { submitContentReport, listModerationQueue, getModerationContext, moderateContent,
  listModerationNotifications, markModerationNotificationRead, markAllModerationNotificationsRead, listReportableComments,
  screenProblemContent, screenProposalContent, screenCommentContent } = registerModerationCallables({
  db, requireMember, requireAdmin, options: MEMBER_CALL_OPTIONS, region: REGION,
});

export const listPostedProposals = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return listPostedProposalsForProblem({ db, uid, problemId: request.data?.problemId });
});

// QCDAO-62 and QCDAO-63 read existing proposal, problem and comment records.
export const listMyProposalQueue = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return listMyProposals({ db, uid });
});

export const listEvaluatorQueue = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return evaluatorQueue({ db, uid, cursor: request.data?.cursor ?? null, filter: request.data?.filter ?? "pending" });
});

export const createComment = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return writeComment({ db, uid, now: Timestamp.now(), proposalId: request.data?.proposalId,
    body: request.data?.body, recommendation: request.data?.recommendation, parentId: request.data?.parentId });
});
export const editComment = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return amendComment({ db, uid, now: Timestamp.now(), commentId: request.data?.commentId,
    body: request.data?.body, recommendation: request.data?.recommendation });
});
export const deleteComment = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return removeComment({ db, uid, now: Timestamp.now(), commentId: request.data?.commentId });
});

// Mock escrow is a server-only ledger. No real tokens move and these records
// never enter the verified funding collection or marketplace funding metrics.
export const getMockMatching = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return readMockMatching({ db, uid, problemId: request.data?.problemId, proposalId: request.data?.proposalId, cursor: request.data?.cursor });
});
export const fundMockProposal = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  const { problemId, proposalId, amount, requestId } = request.data ?? {};
  return contributeMockFunding({ db, uid, problemId, proposalId, amount, requestId });
});
export const selectMockProposal = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return chooseMockProposal({ db, uid, problemId: request.data?.problemId, proposalId: request.data?.proposalId, rationale: request.data?.rationale });
});
export const confirmMockProposal = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return acceptMockProposal({ db, uid, problemId: request.data?.problemId, proposalId: request.data?.proposalId });
});
export const declineMockProposal = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return rejectMockProposal({ db, uid, problemId: request.data?.problemId, proposalId: request.data?.proposalId, reason: request.data?.reason });
});
export const completeMockEvaluation = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  await requireAdmin(request);
  return finishMockEvaluation({ db, uid, problemId: request.data?.problemId, proposalId: request.data?.proposalId });
});
export const forceExpireMockMatch = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  await requireAdmin(request);
  return forceExpireMockWindow({ db, uid, problemId: request.data?.problemId });
});
export const getMockFundingPortfolio = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return readMockFundingPortfolio({ db, uid });
});
export const expireMockMatchingWindows = onSchedule(
  { schedule: "every 5 minutes", region: REGION, maxInstances: 1, retryCount: 3 },
  () => sweepExpiredMockMatches({ db }),
);

export const reserveResource = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  await reserveRecord({ db, uid, scope: request.data?.scope, id: request.data?.recordId, now: Timestamp.now() });
  return { reserved: true };
});

export const reserveAttachment = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return reserveUpload({ db, uid, scope: request.data?.scope, id: request.data?.recordId,
    attachmentId: request.data?.attachmentId, size: request.data?.size, sha256: request.data?.sha256,
    now: Timestamp.now(), Timestamp });
});

export const removeAttachment = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  const { scope, recordId, attachmentId } = request.data ?? {};
  validateResource(scope, recordId);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(attachmentId ?? "")) throw new HttpsError("invalid-argument", "Invalid attachment.");
  const key = uploadReservationKey(scope, recordId, attachmentId);
  const path = uploadObjectPath(scope, uid, recordId, attachmentId);
  const [legacyFileExists] = await getStorage().bucket().file(path).exists();
  // This transaction conflicts with publication sealing, including legacy files.
  await db.runTransaction(async (tx) => {
    const ref = db.collection("uploadReservations").doc(key);
    const [parent, reservation, proof, recordReservation, maintenance] = await Promise.all([
      tx.get(db.collection(scope).doc(recordId)), tx.get(ref),
      tx.get(db.collection("publicationProofs").doc(resourceKey(scope, recordId))),
      tx.get(db.collection("recordReservations").doc(resourceKey(scope, recordId))),
      tx.get(db.collection("maintenanceState").doc("registryCutover")),
    ]);
    if (maintenance.data()?.active || recordReservation.data()?.retired) throw new HttpsError("failed-precondition", "Registry maintenance or retirement prevents removal.");
    if ((parent.exists && (parent.data()[scope === "problems" ? "ownerId" : "researcherId"] !== uid || parent.data().status !== "draft"))
        || (reservation.exists && (!matchesUploadReservation(reservation.data(), {
          scope, id: recordId, uid, attachmentId, path,
        }) || reservation.data().sealed))
        || proof.data()?.record?.attachments?.some((item) => item.id === attachmentId)) {
      throw new HttpsError("permission-denied", "Published attachment bytes must be retained.");
    }
    if (!reservation.exists && !legacyFileExists) return; // No arbitrary permanent tombstones.
    if (!reservation.exists) tx.set(ref, { uid, scope, recordId, attachmentId, path,
      state: "retired", retiredAt: Timestamp.now() });
    else tx.update(ref, { state: "retired", retiredAt: Timestamp.now() });
  });
  await getStorage().bucket().file(path).delete({ ignoreNotFound: true });
  await releaseDeletedUpload({ db, key, deletedPath: path, now: Timestamp.now() });
  return { removed: true };
});

// The client still commits its schema-validated Firestore transaction, including
// the one-proposal-per-author slot. Rules require this server-only exact-content
// attestation, so no submitted create, draft promotion or correction can skip the
// chain. Verifying an arbitrary client-supplied status/hash alone is insufficient.
export const attestPublication = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  const { scope, recordId, record: input } = request.data ?? {};
  validateResource(scope, recordId);
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Buffer.byteLength(JSON.stringify(input)) > 60_000 || (input.attachments?.length ?? 0) > 2) {
    throw new HttpsError("invalid-argument", "Invalid publication content.");
  }
  const record = { ...input, id: recordId };
  if (record[scope === "problems" ? "ownerId" : "researcherId"] !== uid) {
    throw new HttpsError("permission-denied", "You can publish only your own records.");
  }
  if (scope === "problems") {
    const date = new Date(record.expiresAt);
    if (!Number.isFinite(date.getTime())) throw new HttpsError("invalid-argument", "Invalid expiry.");
    record.expiresAt = Timestamp.fromDate(date);
  }
  await reserveRecord({ db, uid, scope, id: recordId, now: Timestamp.now() });
  // Also bound repeated attestations/expensive chain reads for a reserved record.
  const attemptRef = db.collection("publicationAttempts").doc(`${uid}_${Math.floor(Date.now() / 60_000)}`);
  await db.runTransaction(async (tx) => {
    const old = await tx.get(attemptRef);
    const count = old.data()?.count ?? 0;
    if (count >= 10) throw new HttpsError("resource-exhausted", "Wait one minute before retrying publication.");
    tx.set(attemptRef, { count: count + 1, expiresAt: Timestamp.fromMillis(Date.now() + 120_000) });
  });
  try { await verifyPublication({ scope, record, client: publicClient }); }
  catch { throw new HttpsError("failed-precondition", "The content could not be verified against its mined transaction. Wait for confirmation and retry."); }
  const { id: ignoredId, createdAt, updatedAt, audit, ...content } = record;
  const proofRef = db.collection("publicationProofs").doc(resourceKey(scope, recordId));
  await db.runTransaction(async (tx) => {
    const [maintenance, reservation] = await Promise.all([
      tx.get(db.collection("maintenanceState").doc("registryCutover")),
      tx.get(db.collection("recordReservations").doc(resourceKey(scope, recordId))),
    ]);
    if (maintenance.data()?.active || reservation.data()?.retired) throw new HttpsError("failed-precondition", "Registry maintenance or retirement prevents publication.");
    const attachments = record.attachments ?? [];
    const reservations = await Promise.all(attachments.map((item) =>
      tx.get(db.collection("uploadReservations").doc(uploadReservationKey(scope, recordId, item.id)))));
    for (let index = 0; index < reservations.length; index += 1) {
      const reservation = reservations[index], item = attachments[index];
      if (!reservation.exists) continue; // Existing immutable attachments predate reservations.
      const expectedPath = uploadObjectPath(scope, uid, recordId, item.id);
      if (!matchesUploadReservation(reservation.data(), {
        scope, id: recordId, uid, attachmentId: item.id, path: expectedPath,
      }) || reservation.data().size !== item.size || reservation.data().sha256 !== item.sha256) {
        throw new HttpsError("failed-precondition", "An attachment reservation does not match the published file.");
      }
      if (reservation.data().state === "retired") throw new HttpsError("failed-precondition", "An attachment was removed. Select it again.");
      tx.update(reservation.ref, { sealed: true });
    }
    tx.set(proofRef, { uid, record: content, transactionHash: audit.transactionHash, verifiedAt: Timestamp.now() });
  });
  return { verified: true };
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

async function issueNonce({ request, address, ref, domain }) {
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

  return db.runTransaction(async (tx) => {
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

    const fresh = {
      nonce: randomBytes(16).toString("hex"),
      issuedAt: new Date(nowMs).toISOString(),
      domain,
    };

    tx.set(ref, {
      ...fresh,
      address,
      callerHash: sourceHash,
      consumed: false,
      expiresAt: Timestamp.fromMillis(nowMs + NONCE_TTL_MS),
      createdAt: Timestamp.fromMillis(nowMs),
    });

    return fresh;
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
    // One opaque challenge per attempt, not one per wallet: another caller can
    // then neither replace this sign-in nor spend its verification attempts.
    const challengeId = randomBytes(16).toString("hex");
    const ref = db.collection(NONCE_COLLECTION).doc(challengeId);
    const domain = resolveDomain(request);
    const issued = await issueNonce({ request, address, ref, domain });

    return {
      message: buildMessage({ address, ...issued }),
      nonce: issued.nonce,
      issuedAt: issued.issuedAt,
      challengeId,
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
export const verifySiweSignature = onCall({
  region: REGION, maxInstances: NONCE_MAX_INSTANCES,
  enforceAppCheck: process.env.FUNCTIONS_EMULATOR !== "true",
}, async (request) => {
  const address = normaliseAddress(request.data?.address);
  const signature = request.data?.signature;

  // Contract wallets may use variable-length signatures; bound and validate the
  // bytes before spending a database read or making an EIP-1271 RPC request.
  if (typeof signature !== "string" || !/^0x(?:[0-9a-fA-F]{2}){1,2048}$/.test(signature)) {
    throw new HttpsError("invalid-argument", "A valid wallet signature is required.");
  }

  const challengeId = request.data?.challengeId;
  if (challengeId !== undefined && challengeId !== null
      && (typeof challengeId !== "string" || !/^[0-9a-f]{32}$/.test(challengeId))) {
    throw new HttpsError("invalid-argument", "A valid sign-in challenge is required.");
  }
  // Attempts are counted on this document, so a challenge belongs to the caller
  // that opened it. Address-keyed records predate this and drain with their TTL.
  const ref = db.collection(NONCE_COLLECTION).doc(challengeId || address);

  // Bound verification work atomically before cryptography. Failed signatures
  // spend an attempt but never consume the wallet nonce.
  const source = (process.env.FUNCTIONS_EMULATOR === "true" && request.rawRequest?.headers?.["x-emulator-test-source"])
    || request.rawRequest?.ip || request.rawRequest?.socket?.remoteAddress || "unknown";
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const snapshot = await db.runTransaction(async (tx) => {
    const now = Date.now();
    const sourceRef = db.collection(RATE_LIMIT_COLLECTION).doc(`verify_source_${sourceHash}`);
    const globalRef = db.collection(RATE_LIMIT_COLLECTION).doc("verify_global");
    const [nonce, sourceSnapshot, globalSnapshot] = await Promise.all([
      tx.get(ref), tx.get(sourceRef), tx.get(globalRef),
    ]);
    const perSource = quotaCounter(sourceSnapshot, now);
    const global = quotaCounter(globalSnapshot, now);
    const attempts = nonce.data()?.verificationAttempts ?? 0;
    if (perSource.count >= 30 || global.count >= 300 || attempts >= 10) {
      throw new HttpsError("resource-exhausted", "Too many verification attempts. Wait a few minutes and start sign-in again.");
    }
    const expiresAt = Timestamp.fromMillis(now + RATE_LIMIT_WINDOW_MS * 2);
    tx.set(sourceRef, { count: perSource.count + 1, windowStartedAt: Timestamp.fromMillis(perSource.windowStartedAtMs), expiresAt });
    tx.set(globalRef, { count: global.count + 1, windowStartedAt: Timestamp.fromMillis(global.windowStartedAtMs), expiresAt });
    // Reserve attempts atomically BEFORE verification so concurrent failures
    // cannot all pass a read-only counter. Do not consume the wallet's nonce.
    if (nonce.exists) tx.update(ref, { verificationAttempts: attempts + 1 });
    return nonce;
  });
  if (!snapshot.exists) {
    throw new HttpsError("failed-precondition", "No sign-in request is pending for this wallet. Start again.");
  }

  const record = snapshot.data() ?? {};
  if (record.address && record.address !== address) {
    throw new HttpsError("failed-precondition", "That sign-in request belongs to another wallet. Start again.");
  }
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

function auditProposalId(request) {
  const id = request.data?.proposalId;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new HttpsError("invalid-argument", "A valid proposal reference is required.");
  }
  return id;
}

function expiryOpportunityId(request) {
  const id = request.data?.problemId;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new HttpsError("invalid-argument", "A valid opportunity reference is required.");
  }
  return id;
}

function forceExpiryReason(request) {
  const reason = request.data?.reason;
  if (!Object.values(EXPIRY_REASONS).includes(reason)) {
    throw new HttpsError(
      "invalid-argument",
      "Choose one of the prescribed expiry reasons before forcing expiry.",
    );
  }
  return reason;
}

async function recoverAudit(proposalId, manual = false) {
  return recoverProposalAudit({ db, client: publicClient, proposalId, manual, now: Timestamp.now(), Timestamp });
}

export const queueProposalAudit = onDocumentWritten(
  { document: "proposals/{proposalId}", region: REGION, retry: true, maxInstances: 10 },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return;
    await enqueueProposalAudit({ db, record: { ...after.data(), id: after.id }, now: Timestamp.now() });
  },
);

export const recordProposalEdit = onDocumentUpdated(
  { document: "proposals/{proposalId}", region: REGION, retry: true, maxInstances: 10 },
  async (event) => {
    await recordProposalRevision({
      db,
      proposalId: event.params.proposalId,
      eventId: event.id,
      before: event.data?.before?.data(),
      after: event.data?.after?.data(),
      at: Timestamp.now(),
    });
  },
);

export const recordOpportunityEdit = onDocumentUpdated(
  { document: "problems/{problemId}", region: REGION, retry: true, maxInstances: 10 },
  async (event) => {
    await recordOpportunityRevision({
      db,
      recordId: event.params.problemId,
      eventId: event.id,
      before: event.data?.before?.data(),
      after: event.data?.after?.data(),
      at: Timestamp.now(),
    });
  },
);

export const retryPendingProposalAudits = onSchedule(
  { schedule: "every 1 minutes", region: REGION, maxInstances: 1 },
  async () => {
    const jobs = await db.collection(AUDIT_JOBS).where("status", "==", "pending")
      .where("nextAttemptAt", "<=", Timestamp.now()).orderBy("nextAttemptAt").limit(25).get();
    for (const job of jobs.docs) {
      try { await recoverAudit(job.id); } catch (error) { console.warn("Proposal audit recovery:", job.id, error.message); }
    }
  },
);

/** Lapses every due opportunity; an unfinished run resumes from its checkpoint. */
export const lapseExpiredOpportunities = onSchedule(
  { schedule: "every 1 minutes", region: REGION, maxInstances: 1, timeoutSeconds: 540 },
  async () => {
    const summary = await lapseDueOpportunities({ db, Timestamp });
    console.log("Opportunity lapse run", summary);
  },
);

export const confirmProposalAudit = onCall({ region: REGION, maxInstances: 5 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to confirm this receipt.");
  const id = auditProposalId(request);
  const [profile, revocation, proposal] = await Promise.all([
    db.collection("users").doc(uid).get(), db.collection(SESSION_REVOCATIONS_COLLECTION).doc(uid).get(),
    db.collection("proposals").doc(id).get(),
  ]);
  if (!profile.exists || profile.data().suspended || !proposal.exists || proposal.data().researcherId !== uid) {
    throw new HttpsError("permission-denied", "Only the active proposal author can confirm this receipt.");
  }
  if (isAuthTimeRevoked(request.auth.token.auth_time ?? 0, profile.data().sessionsValidAfterEpoch, revocation.data()?.sessionsValidAfterEpoch)) {
    throw new HttpsError("unauthenticated", "This session was revoked. Sign in again.");
  }
  await enqueueProposalAudit({ db, record: { ...proposal.data(), id }, now: Timestamp.now() });
  if (proposal.data().audit?.status === "confirmed") return { status: "confirmed" };
  try { return { audit: await recoverAudit(id) }; }
  catch (error) { throw new HttpsError("unavailable", error.message); }
});

const PROPOSAL_AUDIT_STATUSES = new Set(["failed", "waiting-wallet", "pending", "confirmed"]);
const PROPOSAL_AUDIT_ATTENTION = ["failed", "waiting-wallet"];

export const adminListProposalAudits = onCall({ region: REGION }, async (request) => {
  await requireAdmin(request);
  const status = request.data?.status;
  let query = db.collection(AUDIT_JOBS);
  if (status === "attention") {
    query = query.where("status", "in", PROPOSAL_AUDIT_ATTENTION);
  } else if (status && status !== "all") {
    if (!PROPOSAL_AUDIT_STATUSES.has(status)) {
      throw new HttpsError("invalid-argument", "Invalid verification status filter.");
    }
    query = query.where("status", "==", status);
  }
  query = query.orderBy("updatedAt", "desc");
  const cursor = request.data?.cursor;
  if (cursor) {
    if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(cursor)) throw new HttpsError("invalid-argument", "Invalid page cursor.");
    const snapshot = await db.collection(AUDIT_JOBS).doc(cursor).get();
    if (!snapshot.exists) throw new HttpsError("invalid-argument", "Page cursor no longer exists. Refresh the queue.");
    query = query.startAfter(snapshot);
  }
  const page = await query.limit(26).get();
  const rows = page.docs.slice(0, 25);
  const items = await Promise.all(rows.map(async (row) => {
    const { leaseUntil, ...job } = row.data();
    const proposal = await db.collection("proposals").doc(row.id).get();
    const proposalData = proposal.data();
    let audit = proposalData?.audit || null;
    if (proposal.exists) {
      try {
        const prepared = prepareStoredProposal({ ...proposalData, id: row.id });
        audit = { schemaVersion: 1, chainId: 421614, status: "queued", attemptCount: 0, ...audit,
          entityId: prepared.entityId, contentHash: prepared.contentHash, solutionHash: prepared.solutionHash };
      } catch { audit = null; }
    }
    let opportunity = null;
    const problemId = typeof proposalData?.problemId === "string" ? proposalData.problemId : "";
    if (problemId) {
      const parent = await db.collection("problems").doc(problemId).get();
      opportunity = parent.exists ? serializeOpportunityForAdmin(parent.id, parent.data()) : null;
    }
    return {
      ...job,
      id: row.id,
      audit,
      opportunity,
      updatedAt: job.updatedAt.toDate().toISOString(),
      nextAttemptAt: job.nextAttemptAt.toDate().toISOString(),
    };
  }));
  return { items, cursor: page.size > 25 ? rows.at(-1).id : null };
});

export const adminVerifyProposalAudit = onCall({ region: REGION, maxInstances: 3 }, async (request) => {
  await requireAdmin(request);
  const id = auditProposalId(request);
  const snapshot = await db.collection("proposals").doc(id).get();
  if (!snapshot.exists) throw new HttpsError("not-found", "Proposal no longer exists.");
  try {
    const record = { ...snapshot.data(), id };
    const audit = await verifyMinedProposal(record, publicClient);
    const block = await publicClient.getBlock({ blockNumber: BigInt(audit.blockNumber) });
    return { verified: true, anchor: { anchor: { actor: record.researcherId, timestamp: Number(block.timestamp) } } };
  } catch (error) {
    if (/mismatch/i.test(error.message)) return { verified: false };
    throw new HttpsError("unavailable", "Unable to verify: the transaction may be pending or the network unavailable.");
  }
});

export const adminRetryProposalAudit = onCall({ region: REGION, maxInstances: 3 }, async (request) => {
  await requireAdmin(request);
  const id = auditProposalId(request);
  const proposal = await db.collection("proposals").doc(id).get();
  if (!proposal.exists) throw new HttpsError("not-found", "Proposal no longer exists.");
  const record = proposal.data();
  if (!record.audit?.transactionHash) {
    // An admin cannot impersonate the contract's researcher. Reset only the
    // wallet attempt budget; preserve all proposal content and any known hash.
    await db.runTransaction(async (tx) => {
      const current = await tx.get(proposal.ref);
      if (current.data().audit?.transactionHash) throw new HttpsError("aborted", "A transaction was just submitted. Refresh and resume it.");
      if (current.data().audit) tx.update(proposal.ref, { "audit.attemptCount": 0, "audit.status": "queued", "audit.lastError": "", updatedAt: Timestamp.now() });
    });
    return { message: "Wallet attempts reset. The researcher can start verification from their proposal receipt." };
  }
  await enqueueProposalAudit({ db, record: { ...record, id }, now: Timestamp.now() });
  try { await recoverAudit(id, true); return { message: "Verification confirmed and receipt saved." }; }
  catch (error) { throw new HttpsError("unavailable", error.message); }
});

/** Admin-only force expiry. */
export const adminForceExpireOpportunity = onCall({ region: REGION, maxInstances: 3 }, async (request) => {
  const { uid, adminUser } = await requireAdmin(request);
  const problemId = expiryOpportunityId(request);
  const reason = forceExpiryReason(request);
  const outcome = await expireOpportunity({
    db,
    Timestamp,
    problemId,
    now: Timestamp.now(),
    source: EXPIRY_SOURCES.MANUAL,
    actorId: uid,
    actorName: adminUser.fullName,
    forceReason: reason,
  });

  if (outcome.outcome === "not-found") {
    throw new HttpsError("not-found", "This opportunity no longer exists.");
  }
  if (!outcome.changed) {
    throw new HttpsError("failed-precondition", "Only a response-open opportunity can be force-expired.");
  }
  return { ...outcome, problemId };
});

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
  if (typeof roleFilter === "number" && (roleFilter === 0 || roleFilter === 1 || roleFilter === 2)) {
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

  if (typeof newRole !== "number" || (newRole !== 0 && newRole !== 1 && newRole !== 2)) {
    throw new HttpsError("invalid-argument", "Valid role (0 for User, 1 for Admin, 2 for Evaluator) is required.");
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

/** Clean both namespaces in bounded, resumable pages. Reservations bound new
 * uploads; this job reclaims abandoned charges and objects after the grace period.
 * Sealed published evidence and historical published files are retained. Set
 * ATTACHMENT_SWEEP_ENABLED=true explicitly to enable deletion after a dry run.
 */
export const sweepAttachments = onSchedule(
  {
    region: REGION,
    schedule: "every day 03:00",
    timeZone: "Asia/Singapore",
    timeoutSeconds: 540,
    memory: "512MiB",
    retryCount: 0,
  },
  async () => {
    await sweepOrphanedAttachments({
      db,
      bucket: getStorage().bucket(),
      dryRun: process.env.ATTACHMENT_SWEEP_ENABLED !== "true",
    });
  },
);
