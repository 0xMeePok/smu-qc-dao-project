import { AsyncLocalStorage } from "node:async_hooks";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentCreated, onDocumentUpdated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { createPublicClient, fallback, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { defineSecret } from "firebase-functions/params";
import { exchangePrivySession as mintPrivySession, PrivySessionError } from "./privySession.js";
import { bootstrapAdminEmails, stampUserFromIdentity } from "./privyAccount.js";
import { registerModerationCallables } from "./moderationFunctions.js";
import { registerMatchingNotificationFunctions } from "./matchingNotifications.js";
import { registerEscrowFundingFunctions } from "./escrowFundingFunctions.js";
import { registerOpenFundingFunctions } from "./openFundingFunctions.js";
import { registerIndependentFundingFunctions } from "./independentFundingFunctions.js";
import { registerWalletFaucetFunctions } from "./walletFaucetFunctions.js";
import { registerFxRateFunctions } from "./fxRates.js";
import { assertIndependentPublicationUnlocked } from "./independentFunding.js";
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
import { postingProgressChanged, refreshPostingEscrowProgress } from "./postingEscrowProgress.js";
import { notifyEscrowWorkflowEvent } from "./escrowWorkflowNotifications.js";
import { AUDIT_JOBS, enqueueProposalAudit, recoverProposalAudit, registryAddress, verifyMinedProposal } from "./proposalAuditRecovery.js";
import { THRESHOLDS as STATUS_THRESHOLDS, collectPlatformStatus } from "./platformStatus.js";
import { bindRpcScopeStore, createArbitrumRpcTransport, enableRpcStats, getRpcUrls, withRpcScope } from "./rpcPolicy.js";
import { collectAdminActivity } from "./adminActivity.js";
import auditRegistryBaseConfig from "./auditRegistry.contract.json" with { type: "json" };
import independentFundingConfig from "./independentFunding.contract.json" with { type: "json" };
import { prepareStoredProposal } from "./proposalAuditPayload.js";
import { proposalAuditQueueMetadata } from "./proposalAuditQueue.js";
import { recordProposalRevision } from "./proposalRevisions.js";
import { recordOpportunityRevision } from "./opportunityRevisions.js";
import { EXPIRY_REASONS } from "./opportunityExpiry.js";
import { EXPIRY_SOURCES, expireOpportunity, lapseDueOpportunities } from "./opportunityExpiryService.js";
import { verifyPublication } from "./publication.js";
import { PUBLISH_VALIDATION, INDEPENDENT_PUBLISH_VALIDATION, isPublishableProblem, isPublishableIndependentProposal } from "./publicationValidation.js";
import { requireNewProposalTargetPolicy, requireProposalPublicationFundingPolicy } from "./proposalPublicationPolicy.js";
import { getMockMatching as readMockMatching, fundMockProposal as contributeMockFunding,
  selectMockProposal as chooseMockProposal, confirmMockProposal as acceptMockProposal,
  getMockFundingPortfolio as readMockFundingPortfolio, sweepExpiredMockMatches,
  declineMockProposal as rejectMockProposal, completeMockEvaluation as finishMockEvaluation, forceExpireMockMatch as forceExpireMockWindow } from "./matching.js";
import { createComment as writeComment, editComment as amendComment,
  deleteComment as removeComment } from "./comments.js";
import { listPostedProposals as listPostedProposalsForProblem, listRemovedProblems as listRemovedProblemsForMember, readRemovedProblem as readRemovedProblemForMember } from "./moderation.js";
import { getProposalComparison as readProposalComparison } from "./proposalComparison.js";
import { feedbackByProposal, listActionItems as actionItems, listEvaluatorQueue as evaluatorQueue, listMyProposals } from "./proposalQueues.js";
import { collectOwnerDashboard } from "./ownerDashboard.js";
import { listIndependentListings as independentListings } from "./independentProposalCatalog.js";
import { listOwnerReviews as readOwnerReviews, recordOwnerReview as writeOwnerReview } from "./ownerReviews.js";
import { createFundingApproach as writeFundingApproach, decideFundingApproach as writeFundingApproachDecision, getFundingApproach as readFundingApproach, listFundingApproaches as readFundingApproaches, saveFundingApproachAnchor, saveFundingApproachDecisionAnchors } from "./fundingApproach.js";
import { readAuditTrail } from "./auditTrail.js";
import { getEscrowFundingSummary as readEscrowFundingSummary } from "./escrowFunding.js";
import { matchesUploadReservation, reserveRecord, reserveUpload, releaseDeletedUpload, resourceKey,
  uploadObjectPath, uploadReservationKey, validateResource } from "./resourceQuotas.js";

initializeApp();

// Independent crowdfunding is additive; the existing registry and factory stay
// at their current addresses with their original configuration on disk.
const auditRegistryConfig = { ...auditRegistryBaseConfig, independentFunding: independentFundingConfig };

const db = getFirestore();
const privySecret = defineSecret("PRIVY_SECRET");

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

// Hard ceiling on concurrent instances. Bounds the worst-case cost and blast radius
// of a volumetric flood (many distinct addresses, one call each, so per-address
// idempotency does not help) to a fixed number regardless of how much traffic
// arrives - once instances are saturated, Cloud Run queues or fails fast rather than
// autoscaling without limit. This adds no latency to normal traffic; a handful of
// concurrent sign-ins never gets close to it.
const SIGN_IN_MAX_INSTANCES = 10;

// Must match FUNCTIONS_REGION in frontend/src/lib/firebase.js and the Firestore
// database location. Otherwise every sign-in crosses regions.
const REGION = "asia-southeast1";

export const { getFxRates } = registerFxRateFunctions({ region: REGION });

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

async function projectPostingEscrowProgress(event, kind) {
  if (!postingProgressChanged(kind, event.data?.before?.data(), event.data?.after?.data())) return;
  const ids = kind === "proposal" ? [event.data?.before?.data()?.problemId, event.data?.after?.data()?.problemId]
    : [event.data?.after?.data()?.problemId ?? event.data?.before?.data()?.problemId ?? event.params.problemId];
  for (const problemId of new Set(ids.filter(Boolean))) {
    await refreshPostingEscrowProgress({ db, problemId, config: auditRegistryConfig });
  }
}
export const syncEscrowMarketplaceProgress = onDocumentWritten(
  { document: "escrowFundingSummaries/{summaryId}", region: REGION, maxInstances: 3, retry: true },
  event => projectPostingEscrowProgress(event, "summary"),
);
export const syncEscrowMarketplaceProposal = onDocumentWritten(
  { document: "proposals/{proposalId}", region: REGION, maxInstances: 3, retry: true },
  event => projectPostingEscrowProgress(event, "proposal"),
);
export const syncEscrowMarketplacePosting = onDocumentWritten(
  { document: "problems/{problemId}", region: REGION, maxInstances: 3, retry: true },
  event => projectPostingEscrowProgress(event, "posting"),
);
// QCDAO-68: on-chain selection, rejection and cancellation notices for the
// researcher and posting owner. Escrow events are immutable once written.
export const notifyEscrowWorkflow = onDocumentCreated(
  { document: "escrowFundingEvents/{eventId}", region: REGION, maxInstances: 3, retry: true },
  event => notifyEscrowWorkflowEvent({ db, eventId: event.params.eventId, event: event.data?.data() }),
);

const rpcCallableScope = new AsyncLocalStorage();
bindRpcScopeStore(rpcCallableScope);
if (process.env.NODE_ENV !== "production") enableRpcStats();
const readBatch = { multicall: { batchSize: 1024, wait: 16 } };
const rpcTransport = () => createArbitrumRpcTransport({ http, fallback,
  primaryUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL,
  backupUrls: process.env.ARBITRUM_SEPOLIA_RPC_BACKUP_URLS });
const publicClient = createPublicClient({
  chain: arbitrumSepolia,
  cacheTime: 0,
  batch: readBatch,
  transport: rpcTransport(),
});

// prepareEscrowDeposit runs immediately before a member's deposit signature and
// verifies ~40 escrow fields at one pinned block. Batching those reads through
// Multicall3 turns each round of the request's read queue into one RPC request,
// so the queue can be wider without raising load on rate-limited endpoints.
const batchedReadClient = createPublicClient({
  chain: arbitrumSepolia,
  cacheTime: 0,
  batch: readBatch,
  transport: rpcTransport(),
});

async function requireMember(request) {
  const uid = request.auth?.uid;
  if (!/^0x[0-9a-f]{40}$/.test(uid ?? "")) throw new HttpsError("unauthenticated", "Sign in with your email.");
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

export const { claimWalletTokens } = registerWalletFaucetFunctions({ db, region: REGION });

export const { prepareEscrowDeposit, prepareRemovedProposalClaim, syncEscrowFunding, getEscrowFundingHistory, getEscrowFundingSummary,
  startEscrowSettlement, getEscrowAdminCancellation, startEscrowAdminCancellation,
  queueEscrowFunding, queueEscrowPostingPause, reconcileEscrowFunding } = registerEscrowFundingFunctions({
  db, client: publicClient, batchedReadClient, config: auditRegistryConfig, requireMember, options: MEMBER_CALL_OPTIONS, region: REGION,
});

export const { getOpenFundingSummary, prepareOpenFundingAction, syncOpenFunding, getFunderDashboard } = registerOpenFundingFunctions({
  db, client: publicClient, config: auditRegistryConfig, requireMember, options: MEMBER_CALL_OPTIONS,
});

export const { getIndependentFundingState, prepareIndependentFundingAction, syncIndependentFunding } = registerIndependentFundingFunctions({
  db, client: publicClient, config: auditRegistryConfig, requireMember, options: MEMBER_CALL_OPTIONS, region: REGION,
});

export const { submitContentReport, listModerationQueue, getModerationContext, moderateContent,
  listModerationNotifications, markModerationNotificationRead, markAllModerationNotificationsRead, listReportableComments,
  screenProblemContent, screenProposalContent, screenCommentContent } = registerModerationCallables({
  db, requireMember, requireAdmin, options: MEMBER_CALL_OPTIONS, region: REGION,
});

export const listPostedProposals = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return listPostedProposalsForProblem({ db, uid, problemId: request.data?.problemId });
});

export const listRemovedProblems = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return listRemovedProblemsForMember({ db, uid });
});

export const readRemovedProblem = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return readRemovedProblemForMember({ db, uid, problemId: request.data?.problemId });
});

export const listIndependentListings = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  await requireMember(request);
  return independentListings({ db, cursor: request.data?.cursor ?? null });
});

export const getProposalComparison = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return readProposalComparison({ db, uid, problemId: request.data?.problemId });
});

// QCDAO-62 and QCDAO-63 read existing proposal, problem and comment records.
export const listMyProposalQueue = onCall({ ...MEMBER_CALL_OPTIONS, timeoutSeconds: 180 }, async (request) => {
  const uid = await requireMember(request);
  return listMyProposals({ db, uid, client: publicClient, config: auditRegistryConfig });
});

export const listEvaluatorQueue = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return evaluatorQueue({ db, uid, cursor: request.data?.cursor ?? null, filter: request.data?.filter ?? "pending" });
});

// QCDAO-91 shared "Action Needed" workspace tab.
export const listActionItems = onCall({ ...MEMBER_CALL_OPTIONS, timeoutSeconds: 180 }, async (request) => {
  const uid = await requireMember(request);
  return withRpcScope("listActionItems", () => actionItems({ db, uid, client: publicClient, config: auditRegistryConfig }));
});

/**
 * QCDAO-92 - the owner's postings with their solution counts, funding progress
 * and evaluator-feedback readiness. No chain read: listActionItems already pays
 * for confirmed escrow state, and this answers the Firestore-only questions.
 */
export const listOwnerDashboard = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return collectOwnerDashboard({ db, uid, config: auditRegistryConfig, readFeedback: feedbackByProposal,
    readFundingSummary: () => readEscrowFundingSummary({ db, client: publicClient, config: auditRegistryConfig, uid }) });
});

export const createFundingApproach = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return writeFundingApproach({
    db, uid, config: auditRegistryConfig, now: Timestamp.now(), proposalId: request.data?.proposalId,
    amount: request.data?.amount, currency: request.data?.currency,
    scope: request.data?.scope, message: request.data?.message, expiresAt: request.data?.expiresAt,
  });
});

export const listFundingApproaches = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return readFundingApproaches({ db, uid, now: Timestamp.now() });
});

export const getFundingApproach = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return readFundingApproach({ db, uid, now: Timestamp.now(), approachId: request.data?.approachId });
});

export const decideFundingApproach = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return writeFundingApproachDecision({
    db, uid, config: auditRegistryConfig, now: Timestamp.now(), approachId: request.data?.approachId, decision: request.data?.decision,
    message: request.data?.message, reason: request.data?.reason,
  });
});

export const recordFundingApproachAnchor = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return saveFundingApproachAnchor({
    db, client: publicClient, config: auditRegistryConfig, uid, now: Timestamp.now(),
    approachId: request.data?.approachId, transactionHash: request.data?.transactionHash,
  });
});

export const recordFundingApproachDecisionAnchors = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return saveFundingApproachDecisionAnchors({
    db, client: publicClient, config: auditRegistryConfig, uid, now: Timestamp.now(),
    approachIds: request.data?.approachIds, transactionHash: request.data?.transactionHash,
  });
});

export const recordOwnerReview = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return writeOwnerReview({ db, uid, now: Timestamp.now(), proposalId: request.data?.proposalId,
    outcome: request.data?.outcome, rationale: request.data?.rationale, requestId: request.data?.requestId });
});
export const listOwnerReviews = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  const uid = await requireMember(request);
  return readOwnerReviews({ db, uid, proposalId: request.data?.proposalId });
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

// QCDAO-96 and QCDAO-97. One chronological trail over the records the caller may view.
export const listAuditTrail = onCall(MEMBER_CALL_OPTIONS, async (request) => {
  // The profile read overlaps the session check instead of following it; it is
  // used only once requireMember has accepted this uid.
  const claimed = request.auth?.uid;
  const [uid, profileSnap] = await Promise.all([requireMember(request),
    /^0x[0-9a-f]{40}$/.test(claimed ?? "") ? db.collection("users").doc(claimed).get() : null]);
  const profile = (profileSnap ?? await db.collection("users").doc(uid).get()).data();
  return readAuditTrail({ db, uid, profile, input: request.data ?? {} });
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
  if (scope === "problems" || (scope === "proposals" && record.proposalKind === "independent")) {
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
  if (scope === "proposals" && record.proposalKind === "independent") {
    await assertIndependentPublicationUnlocked({ db, client: publicClient, config: auditRegistryConfig, proposalId: recordId, record });
  }
  try { await verifyPublication({ scope, record, client: publicClient }); }
  catch { throw new HttpsError("failed-precondition", "The content could not be verified against its mined transaction. Wait for confirmation and retry."); }
  const { id: ignoredId, createdAt, updatedAt, audit, ...content } = record;
  const proofRef = db.collection("publicationProofs").doc(resourceKey(scope, recordId));
  await db.runTransaction(async (tx) => {
    const [maintenance, reservation, profile, existingProposal] = await Promise.all([
      tx.get(db.collection("maintenanceState").doc("registryCutover")),
      tx.get(db.collection("recordReservations").doc(resourceKey(scope, recordId))),
      scope === "problems" ? tx.get(db.collection("users").doc(uid)) : Promise.resolve(null),
      scope === "proposals" ? tx.get(db.collection("proposals").doc(recordId)) : Promise.resolve(null),
    ]);
    if (maintenance.data()?.active || reservation.data()?.retired) throw new HttpsError("failed-precondition", "Registry maintenance or retirement prevents publication.");
    if (scope === "proposals") {
      try {
        requireProposalPublicationFundingPolicy(record);
        requireNewProposalTargetPolicy(record, { existingRecord: existingProposal?.data() });
      }
      catch (error) { throw new HttpsError("failed-precondition", error.message); }
    }
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
    // Marked only when the full marketplace schema holds. firestore.rules trusts a
    // publish against this proof without re-running those checks, because running
    // them there crossed Firestore's 1,000-expression cap. An unmarked proof still
    // serves the other paths (edits), which keep their own rules validation.
    const publishableProblem = scope === "problems" && isPublishableProblem(content, {
      uid, profileOrganisation: profile?.data()?.organisation,
    });
    const publishableIndependent = scope === "proposals" && isPublishableIndependentProposal(content, { uid });
    const validation = publishableProblem ? PUBLISH_VALIDATION
      : publishableIndependent ? INDEPENDENT_PUBLISH_VALIDATION
      : null;
    tx.set(proofRef, {
      uid, record: content, transactionHash: audit.transactionHash, verifiedAt: Timestamp.now(),
      ...(validation ? { validation } : {}),
    });
  });
  return { verified: true };
});

/**
 * Sign-in. Verifies the Privy access token, resolves that user's embedded
 * wallet, and mints a Firebase custom token whose uid is the wallet address.
 * The browser does not name the account. PRIVY_SECRET is the functions secret
 * the operator set. PRIVY_APP_ID is public: the functions env when deployed,
 * frontend/.env.local's VITE_PRIVY_APP_ID in the emulator (see privyAppId).
 */
export const exchangePrivySession = onCall({
  region: REGION,
  maxInstances: SIGN_IN_MAX_INSTANCES,
  secrets: [privySecret],
  enforceAppCheck: process.env.FUNCTIONS_EMULATOR !== "true",
}, async (request) => {
  try {
    return await mintPrivySession(request, { db, getAuth, Timestamp });
  } catch (error) {
    if (error instanceof PrivySessionError) throw new HttpsError(error.code, error.message);
    throw new HttpsError("unavailable", "Sign-in could not be confirmed. Try again in a moment.");
  }
});

/**
 * Onboarding creates users/{address} without email: rules forbid the client
 * from writing it. This copies the binding exchangePrivySession stored, and
 * grants role 1 when the email is on ADMIN_BOOTSTRAP_EMAILS.
 */
export const stampPrivyIdentity = onDocumentCreated(
  { document: "users/{address}", region: REGION, retry: true, maxInstances: 5 },
  async (event) => {
    const address = String(event.params.address || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) return;
    await stampUserFromIdentity({
      db,
      Timestamp,
      address,
      adminEmails: bootstrapAdminEmails(),
    });
  },
);

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
    const { audit, proposalKind, problemId } = proposalAuditQueueMetadata(row.id, proposalData);
    let opportunity = null;
    if (problemId) {
      const parent = await db.collection("problems").doc(problemId).get();
      opportunity = parent.exists ? serializeOpportunityForAdmin(parent.id, parent.data()) : null;
    }
    return {
      ...job,
      id: row.id,
      title: proposalData?.title ?? job.title,
      proposalKind,
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

// Chain validation plus a read can take two round trips per endpoint. Keep
// each short enough to try the configured endpoints within the 5 s probe.
const statusClient = createPublicClient({
  chain: arbitrumSepolia,
  cacheTime: 0,
  transport: createArbitrumRpcTransport({ http, fallback,
    primaryUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL,
    backupUrls: process.env.ARBITRUM_SEPOLIA_RPC_BACKUP_URLS,
    timeoutMs: Math.max(1, Math.floor(STATUS_THRESHOLDS.rpcTimeoutMs / (2 * getRpcUrls({
      primaryUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL,
      backupUrls: process.env.ARBITRUM_SEPOLIA_RPC_BACKUP_URLS,
    }).length + 1))) }),
});

/**
 * QCDAO-140 - what is on the platform right now, counted from existing records.
 * Separate from adminGetPlatformStatus, which answers whether the dependencies
 * are healthy. An outage and an empty marketplace need different responses.
 */
export const adminGetActivitySummary = onCall({ region: REGION, maxInstances: 3, timeoutSeconds: 30 }, async (request) => {
  await requireAdmin(request);
  return collectAdminActivity({ db });
});

/** Admin-only pre-demo health snapshot: RPC, AuditRegistry, anchoring queue, Alchemy and Firestore. */
export const adminGetPlatformStatus = onCall({ region: REGION, maxInstances: 3, timeoutSeconds: 30 }, async (request) => {
  await requireAdmin(request);
  return collectPlatformStatus({
    client: statusClient,
    rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL,
    db,
    auditJobsCollection: AUDIT_JOBS,
    toTimestamp: (millis) => Timestamp.fromMillis(millis),
    registry: auditRegistryConfig,
    resolveRegistryAddress: registryAddress,
  });
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
      email: data.email || "",
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
      u.email.toLowerCase().includes(searchLower) ||
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

/** The admin callables take a member's wallet address as the Firestore user id. */
function normaliseAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new HttpsError("invalid-argument", "A valid wallet address is required.");
  }
  return value.toLowerCase();
}

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
