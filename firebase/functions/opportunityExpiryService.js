import { AggregateField, FieldPath } from "firebase-admin/firestore";
import {
  COUNTED_FUNDING_STATUSES,
  EXPIRY_REASONS,
  PENDING_PROPOSAL_STATUSES,
  RESPONSE_OPEN_STATUSES,
  expiryReasonFromFacts,
  hasMockMatchingLifecycle,
  isExpiredOpenOpportunity,
} from "./opportunityExpiry.js";

/** Allowed expiry sources. */
export const EXPIRY_SOURCES = Object.freeze({
  SCHEDULED: "scheduled",
  MANUAL: "manual",
});

/** Where an unfinished lapse run resumes. */
export const LAPSE_CHECKPOINT_PATH = Object.freeze(["jobState", "opportunityLapse"]);

const VALID_EXPIRY_REASONS = new Set(Object.values(EXPIRY_REASONS));
const PROPOSAL_ID_PAGE_SIZE = 300;
// Firestore allows at most 30 values in one `in` filter.
const EVALUATION_ID_CHUNK = 30;

function snapshotExists(snapshot) {
  return typeof snapshot?.exists === "function"
    ? Boolean(snapshot.exists())
    : Boolean(snapshot?.exists);
}

function snapshotData(snapshot) {
  return typeof snapshot?.data === "function" ? snapshot.data() ?? {} : {};
}

function statusOf(record) {
  return String(record?.status ?? "").trim().toLowerCase();
}

function isOpenOpportunity(record) {
  return RESPONSE_OPEN_STATUSES.has(statusOf(record));
}

function normaliseSource(source) {
  if (source === undefined || source === null || source === "") {
    return EXPIRY_SOURCES.SCHEDULED;
  }
  if (source === EXPIRY_SOURCES.SCHEDULED || source === EXPIRY_SOURCES.MANUAL) {
    return source;
  }
  throw new TypeError("Expiry source must be 'scheduled' or 'manual'.");
}

function requiredForceReason(forceReason) {
  if (!VALID_EXPIRY_REASONS.has(forceReason)) {
    throw new TypeError("Manual expiry requires one of the prescribed expiry reasons.");
  }
  return forceReason;
}

function currentTime(Timestamp, now) {
  if (now !== undefined && now !== null) return now;
  if (typeof Timestamp?.now === "function") return Timestamp.now();
  return new Date();
}

function result(outcome, extras = {}) {
  return { changed: false, outcome, ...extras };
}

function openStatusResult(record) {
  const status = statusOf(record);
  if (status === "expired") return result("already-expired");
  return result("not-open", { status });
}

async function fundedAmountFor(db, problemId) {
  const totals = await db.collection("funding")
    .where("problemId", "==", problemId)
    .where("status", "in", [...COUNTED_FUNDING_STATUSES])
    .aggregate({ total: AggregateField.sum("amount") })
    .get();
  return Number(totals.data()?.total ?? 0);
}

async function anyDocument(query) {
  const snapshot = await query.limit(1).get();
  return (snapshot.docs?.length ?? 0) > 0;
}

function hasPendingProposal(db, problemId) {
  return anyDocument(db.collection("proposals")
    .where("problemId", "==", problemId)
    .where("status", "in", [...PENDING_PROPOSAL_STATUSES]));
}

async function hasUnacceptedEvaluation(db, problemId) {
  let cursor = null;
  for (;;) {
    let page = db.collection("proposals")
      .where("problemId", "==", problemId)
      .orderBy(FieldPath.documentId())
      .select()
      .limit(PROPOSAL_ID_PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const { docs = [] } = await page.get();
    for (let index = 0; index < docs.length; index += EVALUATION_ID_CHUNK) {
      const ids = docs.slice(index, index + EVALUATION_ID_CHUNK).map((document) => document.id);
      const { docs: evaluations = [] } = await db.collection("evaluations").where("proposalId", "in", ids).get();
      if (evaluations.some((evaluation) => statusOf(snapshotData(evaluation)) !== "accepted")) return true;
    }
    if (docs.length < PROPOSAL_ID_PAGE_SIZE) return false;
    cursor = docs[docs.length - 1];
  }
}

// Rules freeze funding and evaluations once the deadline passes, so facts are read
// before the transaction, in precedence order, and stop at the first reason found.
async function scheduledExpiryReason(db, problemId, problem, now) {
  const facts = { opportunity: problem, now, fundedAmount: await fundedAmountFor(db, problemId) };
  const byFunding = expiryReasonFromFacts(facts);
  if (byFunding === EXPIRY_REASONS.FUNDING_REQUIREMENT_NOT_MET) return byFunding;
  const pending = await hasPendingProposal(db, problemId);
  return expiryReasonFromFacts({
    ...facts,
    hasPendingProposal: pending,
    hasUnacceptedEvaluation: pending ? false : await hasUnacceptedEvaluation(db, problemId),
  });
}

function auditEntry({ problemId, problem, reason, source, actorId, actorName, now }) {
  const actor = String(actorId || (source === EXPIRY_SOURCES.MANUAL ? "admin" : "system"));
  return {
    type: "opportunity_expired",
    action: source === EXPIRY_SOURCES.MANUAL
      ? "OPPORTUNITY_FORCE_EXPIRED"
      : "OPPORTUNITY_EXPIRED",
    source,
    reason,
    actor,
    actorName: String(actorName || (source === EXPIRY_SOURCES.MANUAL ? actor : "System scheduler")),
    target: problemId,
    targetId: problemId,
    targetType: "opportunity",
    targetName: String(problem?.title || problemId),
    timestamp: now,
    createdAt: now,
  };
}

function refundTrigger({ problemId, reason, source, now }) {
  return {
    problemId,
    status: "pending",
    source,
    reason,
    trigger: "opportunity_expired",
    createdAt: now,
    updatedAt: now,
  };
}

/** Persist an expiry transition and its audit/refund hand-off. */
export async function expireOpportunity({
  db,
  Timestamp,
  problemId,
  now,
  source,
  actorId,
  actorName,
  forceReason,
} = {}) {
  if (!db || typeof db.collection !== "function" || typeof db.runTransaction !== "function") {
    throw new TypeError("A Firestore database with collection and runTransaction is required.");
  }
  if (!String(problemId ?? "").trim()) {
    throw new TypeError("A problem id is required to expire an opportunity.");
  }

  const expirySource = normaliseSource(source);
  const timestamp = currentTime(Timestamp, now);
  const problemRef = db.collection("problems").doc(problemId);
  const initial = await problemRef.get();
  if (!snapshotExists(initial)) return result("not-found");

  const initialProblem = snapshotData(initial);
  if (!isOpenOpportunity(initialProblem)) return openStatusResult(initialProblem);
  // This legacy path hands refunds to on-chain escrow. Mock pledges and their
  // full seven-day creator window must instead be settled by matching.js.
  if (hasMockMatchingLifecycle(initialProblem)) return result("mock-matching-managed");

  let reason;
  if (expirySource === EXPIRY_SOURCES.MANUAL) {
    reason = requiredForceReason(forceReason);
  } else {
    if (!isExpiredOpenOpportunity(initialProblem, timestamp)) return result("not-due");
    reason = await scheduledExpiryReason(db, problemId, initialProblem, timestamp);
    if (!reason) return result("no-expiry-reason");
  }

  const auditRef = db.collection("audits").doc();
  const refundRef = db.collection("escrowRefundTriggers").doc(problemId);

  return db.runTransaction(async (transaction) => {
    const current = await transaction.get(problemRef);
    if (!snapshotExists(current)) return result("not-found");

    const problem = snapshotData(current);
    if (!isOpenOpportunity(problem)) return openStatusResult(problem);
    // Funding/selection can initialise matching after the preflight read.
    if (hasMockMatchingLifecycle(problem)) return result("mock-matching-managed");
    if (expirySource === EXPIRY_SOURCES.SCHEDULED && !isExpiredOpenOpportunity(problem, timestamp)) {
      return result("not-due");
    }

    transaction.update(problemRef, {
      status: "expired",
      expiryReason: reason,
      expirySource,
      expiryActor: String(actorId || (expirySource === EXPIRY_SOURCES.MANUAL ? "administrator" : "system")),
      expiryActorName: String(actorName || (expirySource === EXPIRY_SOURCES.MANUAL ? "Administrator" : "System scheduler")),
      expiredAt: timestamp,
      updatedAt: timestamp,
    });
    transaction.set(auditRef, auditEntry({
      problemId,
      problem,
      reason,
      source: expirySource,
      actorId,
      actorName,
      now: timestamp,
    }));
    transaction.set(refundRef, refundTrigger({
      problemId,
      reason,
      source: expirySource,
      now: timestamp,
    }), { merge: true });

    return {
      changed: true,
      outcome: "expired",
      reason,
      source: expirySource,
    };
  });
}

async function processBatch({ db, Timestamp, now, batch, summary, onError }) {
  const outcomes = await Promise.allSettled(batch.map((document) => expireOpportunity({
    db, Timestamp, problemId: document.id, now, source: EXPIRY_SOURCES.SCHEDULED,
  })));
  outcomes.forEach((outcome, index) => {
    summary.visited += 1;
    if (outcome.status === "rejected") {
      summary.failed += 1;
      onError(batch[index].id, outcome.reason);
    } else if (outcome.value?.changed) {
      summary.expired += 1;
    }
  });
}

/**
 * Lapses every due opportunity, one status at a time and oldest first. When the time
 * budget runs out it records where it stopped, so a backlog of any size is worked through.
 */
export async function lapseDueOpportunities({
  db,
  Timestamp,
  now,
  pageSize = 200,
  concurrency = 20,
  budgetMs = 240_000,
  clock = Date.now,
  onError = (problemId, error) => console.error("Opportunity expiry lapse failed:", problemId, error),
} = {}) {
  const startedAt = clock();
  const timestamp = currentTime(Timestamp, now);
  const statuses = [...RESPONSE_OPEN_STATUSES];
  const checkpointRef = db.collection(LAPSE_CHECKPOINT_PATH[0]).doc(LAPSE_CHECKPOINT_PATH[1]);
  const checkpoint = snapshotData(await checkpointRef.get());
  const resumed = statuses.includes(checkpoint.status);
  let statusIndex = resumed ? statuses.indexOf(checkpoint.status) : 0;
  let cursor = resumed && checkpoint.cursorId ? [checkpoint.cursorExpiresAt, checkpoint.cursorId] : null;
  const summary = { visited: 0, expired: 0, failed: 0, resumed, complete: false };
  const withinBudget = () => clock() - startedAt < budgetMs;

  while (statusIndex < statuses.length && withinBudget()) {
    // Equality, range, order and cursor: a shape Firestore serves from the (status, expiresAt) index.
    let query = db.collection("problems")
      .where("status", "==", statuses[statusIndex])
      .where("expiresAt", "<=", timestamp)
      .orderBy("expiresAt", "asc")
      .orderBy(FieldPath.documentId(), "asc")
      .limit(pageSize);
    if (cursor) query = query.startAfter(...cursor);
    const { docs = [] } = await query.get();

    let processed = 0;
    while (processed < docs.length && withinBudget()) {
      const batch = docs.slice(processed, processed + concurrency);
      await processBatch({ db, Timestamp, now: timestamp, batch, summary, onError });
      processed += batch.length;
      const last = batch[batch.length - 1];
      cursor = [snapshotData(last).expiresAt, last.id];
    }

    if (processed < docs.length) break;
    if (docs.length < pageSize) {
      statusIndex += 1;
      cursor = null;
    }
  }

  if (statusIndex >= statuses.length) {
    if (checkpoint.status || checkpoint.cursorId) await checkpointRef.delete();
    summary.complete = true;
    return summary;
  }
  await checkpointRef.set({
    status: statuses[statusIndex],
    cursorExpiresAt: cursor ? cursor[0] : null,
    cursorId: cursor ? cursor[1] : null,
    updatedAt: timestamp,
  });
  return summary;
}
