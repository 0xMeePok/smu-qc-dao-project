import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { ROLE_EVALUATOR } from "./comments.js";
import { correctionPathOpen, ownerReviewSummary, reviewStillOpen } from "./ownerReviews.js";
import { mockSelectionState } from "./matching.js";
import { problemIsMemberBrowsable } from "./moderation.js";
import { WORKFLOW_STATUS, proposalWorkflowStatus, recommendationCounts, recommendationEntries } from "./workflowStatus.js";

// QCDAO-62/63 read the queues out of the records that already exist: proposals,
// their parent problems and the comments collection. Nothing new is stored.
const LIVE_PROBLEM = ["submitted", "open"];
// A recommendation belongs on a solution still under consideration.
const OPEN_PROPOSAL = ["submitted", "under_review"];
const BLOCKED = new Set(["hidden", "removed"]);
const CLOSED_WORKFLOW = new Set([WORKFLOW_STATUS.ACCEPTED, WORKFLOW_STATUS.REFUNDED,
  WORKFLOW_STATUS.INVALIDATED, WORKFLOW_STATUS.DECLINED]);
const MINE_CAP = 200;
const PROBLEM_PAGE = 20;
const QUEUE_CAP = 100;
const OWNED_CAP = 200;
const REVIEW_CAP = 200;
const IN_CHUNK = 30;

const fail = (code, message) => { throw new HttpsError(code, message); };
const iso = (value) => value?.toDate?.().toISOString?.() ?? null;
const millis = (value) => value?.toMillis?.() ?? 0;
const usesEscrow = (proposal) => Object.hasOwn(proposal || {}, "fundingTerms");
const chunks = (values, size = IN_CHUNK) => Array.from(
  { length: Math.ceil(values.length / size) }, (ignored, index) => values.slice(index * size, index * size + size));

function visibleComment(data) {
  return !data.deletedAt && !BLOCKED.has(data.moderationStatus);
}

/** Comment counts and qualifying recommendations, keyed by proposal id. */
async function feedbackByProposal(db, proposalIds) {
  const summary = new Map(proposalIds.map((id) => [id, { comments: 0, qualifying: 0, recommendations: [] }]));
  const pages = await Promise.all(chunks(proposalIds).map((ids) =>
    db.collection("comments").where("proposalId", "in", ids).get()));
  for (const page of pages) {
    for (const doc of page.docs) {
      const data = doc.data();
      const row = summary.get(data.proposalId);
      if (!row || !visibleComment(data)) continue;
      row.comments += 1;
      if (data.qualifying !== true) continue;
      row.qualifying += 1;
      row.recommendations.push(data.recommendation);
    }
  }
  return summary;
}

async function problemsById(db, ids) {
  if (!ids.length) return new Map();
  const docs = await db.getAll(...ids.map((id) => db.collection("problems").doc(id)));
  return new Map(docs.filter((doc) => doc.exists).map((doc) => [doc.id, doc.data()]));
}

// Only what a researcher or evaluator needs to read the posting's state: whether
// a match is pending, confirmed or invalidated and when the creator's response
// window ends. The selected proposal, funded totals and approvals stay private.
function matchingView(matching) {
  const status = matching?.status;
  if (!["awaiting_confirmation", "confirmed", "invalidated"].includes(status)) return null;
  return { status, deadlineAt: iso(matching.deadlineAt), confirmedAt: iso(matching.confirmedAt) };
}

function postingView(id, problem) {
  return problem
    ? {
      id, title: problem.title ?? "", status: problem.status ?? "", expiresAt: iso(problem.expiresAt),
      matching: matchingView(problem.matching),
    }
    : { id, title: "", status: "", expiresAt: null, matching: null };
}

async function activeProfile(db, uid) {
  if (!uid) fail("unauthenticated", "Sign in to continue.");
  const profile = await db.collection("users").doc(uid).get();
  if (!profile.exists || profile.data().suspended) fail("permission-denied", "An active member profile is required.");
  return profile.data();
}

/**
 * QCDAO-62. Every proposal this member has authored, with its parent posting,
 * evaluator-feedback progress and comment count.
 */
export async function listMyProposals({ db, uid }) {
  await activeProfile(db, uid);
  const rows = await db.collection("proposals").where("researcherId", "==", uid).limit(MINE_CAP + 1).get();
  const docs = rows.docs.slice(0, MINE_CAP);
  const [problems, feedback, latestReviews] = await Promise.all([
    problemsById(db, [...new Set(docs.map((doc) => doc.data().problemId).filter(Boolean))]),
    feedbackByProposal(db, docs.map((doc) => doc.id)),
    docs.length
      ? db.getAll(...docs.map((doc) => db.collection(`proposals/${doc.id}/ownerReviewLatest`).doc("current")))
      : [],
  ]);
  const latestByProposal = new Map(latestReviews.filter((snap) => snap.exists).map((snap) => [snap.ref.path.split("/")[1], snap.data()]));
  const items = docs.map((doc) => {
    const data = doc.data();
    const counts = feedback.get(doc.id) ?? { comments: 0, qualifying: 0, recommendations: [] };
    return {
      id: doc.id,
      title: data.title ?? "",
      status: data.status ?? "",
      amount: data.amount ?? 0,
      currency: data.currency ?? "",
      createdAt: iso(data.createdAt),
      updatedAt: iso(data.updatedAt),
      proposalKind: data.proposalKind ?? null,
      expiresAt: iso(data.expiresAt),
      problemId: data.problemId ?? null,
      posting: postingView(data.problemId, problems.get(data.problemId)),
      evaluationComplete: data.matching?.evaluationComplete === true,
      matchingStatus: data.matching?.status ?? null,
      workflowStatus: proposalWorkflowStatus(data, problems.get(data.problemId)?.matching),
      ownerReview: ownerReviewSummary(latestByProposal.get(doc.id)),
      ...counts,
    };
  });
  items.sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0));
  return { items, truncated: rows.size > MINE_CAP };
}

/**
 * QCDAO-63. Proposals this evaluator may still file a recommendation comment on.
 * Evaluators self-select from the eligible pool: an administrator assigns the
 * evaluator access level, and every live posting's solutions are then open to
 * them. Ordered by closing soonest so the tightest deadlines surface first.
 */
export async function listEvaluatorQueue({ db, uid, cursor = null, filter = "pending" }) {
  const profile = await activeProfile(db, uid);
  if (profile.role !== ROLE_EVALUATOR) fail("permission-denied", "Only an assigned evaluator can open this queue.");
  let query = db.collection("problems").where("status", "in", LIVE_PROBLEM)
    .orderBy("expiresAt", "asc").orderBy(FieldPath.documentId(), "asc").limit(PROBLEM_PAGE);
  if (cursor?.expiresAt && cursor?.id) query = query.startAfter(Timestamp.fromMillis(cursor.expiresAt), cursor.id);
  const problems = await query.get();
  const open = problems.docs.filter((doc) => problemIsMemberBrowsable(doc.data()));
  const pages = await Promise.all(open.map((doc) => db.collection("proposals")
    .where("problemId", "==", doc.id).where("status", "in", OPEN_PROPOSAL).limit(QUEUE_CAP).get()));
  const wanted = filter === "submitted" ? "submitted" : "pending";
  const candidates = [];
  open.forEach((problem, index) => {
    for (const doc of pages[index].docs) {
      const data = doc.data();
      // An evaluator may also author solutions; they cannot recommend their own.
      if (BLOCKED.has(data.moderationStatus) || data.researcherId === uid) continue;
      // Each evaluator files their own recommendation, whatever others have filed.
      const mine = recommendationEntries(data)[uid] ?? null;
      candidates.push({ doc, data, problem, mine });
    }
  });
  const items = candidates.map(({ doc, data, problem, mine }) => ({
    id: doc.id,
    title: data.title ?? "",
    status: data.status ?? "",
    workflowStatus: proposalWorkflowStatus(data, problem.data().matching),
    submittedAt: iso(data.createdAt),
    posting: postingView(problem.id, problem.data()),
    recommendationStatus: mine ? "submitted" : "pending",
    recommendation: mine?.recommendation ?? null,
    recommendedAt: mine ? iso(mine.at) : null,
    recommendations: recommendationCounts(data),
  })).filter((item) => item.recommendationStatus === wanted
    // A decided or closed proposal is no longer waiting on anyone's view; my history keeps it.
    && (wanted === "submitted" || !CLOSED_WORKFLOW.has(item.workflowStatus)));
  const last = problems.docs.at(-1);
  return {
    items,
    filter: wanted,
    nextCursor: problems.size === PROBLEM_PAGE && last
      ? { expiresAt: millis(last.data().expiresAt), id: last.id }
      : null,
  };
}

// Every Action Needed group lists the latest submission first.
const newestFirst = (items) => items.sort((a, b) => (Date.parse(b.submittedAt) || 0) - (Date.parse(a.submittedAt) || 0));

function actionView(doc, data, problemId, problem, extra = {}) {
  return {
    id: doc.id, title: data.title ?? "", problemId, posting: postingView(problemId, problem),
    ...(usesEscrow(data) ? { fundingTerms: data.fundingTerms } : {}),
    amount: data.amount ?? 0, currency: data.currency ?? "", fundedAmount: usesEscrow(data) ? 0 : (data.matching?.fundedMinor || 0) / 100,
    workflowStatus: proposalWorkflowStatus(data, problem?.matching), recommendations: recommendationCounts(data),
    submittedAt: iso(data.createdAt), ...extra,
  };
}

/**
 * QCDAO-91. What this member can act on now, across every role they hold:
 * owners select or review, researchers answer a selection, evaluators recommend.
 */
export async function listActionItems({ db, uid, now = Timestamp.now() }) {
  const profile = await activeProfile(db, uid);
  const [owned, mine] = await Promise.all([
    db.collection("problems").where("ownerId", "==", uid).limit(OWNED_CAP).get(),
    db.collection("proposals").where("researcherId", "==", uid).limit(MINE_CAP).get(),
  ]);
  // Only postings still taking decisions; the rest have nothing left to act on.
  const live = owned.docs.filter((doc) => LIVE_PROBLEM.includes(doc.data().status)
    && (doc.data().matching?.status || "open") === "open" && problemIsMemberBrowsable(doc.data())
    && (!millis(doc.data().expiresAt) || millis(doc.data().expiresAt) > now.toMillis()));
  const pages = await Promise.all(live.map((doc) => db.collection("proposals")
    .where("problemId", "==", doc.id).where("status", "in", OPEN_PROPOSAL).limit(QUEUE_CAP).get()));
  const selectable = [];
  const reviewable = [];
  live.forEach((problem, index) => {
    for (const doc of pages[index].docs) {
      const data = doc.data();
      if (BLOCKED.has(data.moderationStatus) || data.moderated) continue;
      if (mockSelectionState({ problem: problem.data(), proposal: { id: doc.id, ...data }, uid, at: now }).canSelect) {
        selectable.push(actionView(doc, data, problem.id, problem.data()));
      }
      if (data.researcherId !== uid && reviewStillOpen(data, problem.data())) reviewable.push({ doc, data, problem });
    }
  });
  const candidates = reviewable.slice(0, REVIEW_CAP);
  const latest = candidates.length
    ? await db.getAll(...candidates.map(({ doc }) => db.collection(`proposals/${doc.id}/ownerReviewLatest`).doc("current")))
    : [];
  const selectableIds = new Set(selectable.map((item) => item.id));
  // A proposal shows once: an unreviewed one sits under review, offering Select there too.
  const awaitingReview = newestFirst(candidates.filter((ignored, index) => !latest[index].exists)
    .map(({ doc, data, problem }) => actionView(doc, data, problem.id, problem.data(),
      { revisionPathOpen: !usesEscrow(data) && correctionPathOpen(data, problem.data()), canSelect: selectableIds.has(doc.id) })));
  const reviewIds = new Set(awaitingReview.map((item) => item.id));
  const readyToSelect = newestFirst(selectable.filter((item) => !reviewIds.has(item.id)));

  // A selection waits on its creator until they answer or the window closes.
  const selected = mine.docs.filter((doc) => !usesEscrow(doc.data()) && doc.data().matching?.status === "awaiting_confirmation"
    && !doc.data().matching?.creatorApprovedBy && millis(doc.data().matching?.deadlineAt) > now.toMillis());
  const parents = await problemsById(db, [...new Set(selected.map((doc) => doc.data().problemId).filter(Boolean))]);
  const selectionToAccept = newestFirst(selected
    .filter((doc) => parents.get(doc.data().problemId)?.matching?.proposalId === doc.id)
    .map((doc) => actionView(doc, doc.data(), doc.data().problemId, parents.get(doc.data().problemId),
      { deadlineAt: iso(doc.data().matching.deadlineAt) })));

  let evaluator = null;
  if (profile.role === ROLE_EVALUATOR) {
    const queue = await listEvaluatorQueue({ db, uid, filter: "pending" });
    evaluator = { awaitingRecommendation: newestFirst(queue.items), more: Boolean(queue.nextCursor) };
  }
  const total = readyToSelect.length + awaitingReview.length + selectionToAccept.length
    + (evaluator?.awaitingRecommendation.length ?? 0);
  return { owner: { readyToSelect, awaitingReview }, researcher: { selectionToAccept }, evaluator, total,
    truncated: owned.size === OWNED_CAP || reviewable.length > REVIEW_CAP };
}
