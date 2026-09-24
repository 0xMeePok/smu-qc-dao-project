import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { ROLE_EVALUATOR } from "./comments.js";
import { problemIsMemberBrowsable } from "./moderation.js";

// QCDAO-62/63 read the queues out of the records that already exist: proposals,
// their parent problems and the comments collection. Nothing new is stored.
const LIVE_PROBLEM = ["submitted", "open"];
// A recommendation belongs on a solution still under consideration.
const OPEN_PROPOSAL = ["submitted", "under_review"];
const BLOCKED = new Set(["hidden", "removed"]);
const MINE_CAP = 200;
const PROBLEM_PAGE = 20;
const QUEUE_CAP = 100;
const IN_CHUNK = 30;

const fail = (code, message) => { throw new HttpsError(code, message); };
const iso = (value) => value?.toDate?.().toISOString?.() ?? null;
const millis = (value) => value?.toMillis?.() ?? 0;
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

function postingView(id, problem) {
  return problem
    ? { id, title: problem.title ?? "", status: problem.status ?? "", expiresAt: iso(problem.expiresAt) }
    : { id, title: "", status: "", expiresAt: null };
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
  const [problems, feedback] = await Promise.all([
    problemsById(db, [...new Set(docs.map((doc) => doc.data().problemId).filter(Boolean))]),
    feedbackByProposal(db, docs.map((doc) => doc.id)),
  ]);
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
      problemId: data.problemId ?? null,
      posting: postingView(data.problemId, problems.get(data.problemId)),
      evaluationComplete: data.matching?.evaluationComplete === true,
      matchingStatus: data.matching?.status ?? null,
      ...counts,
    };
  });
  items.sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0));
  return { items, truncated: rows.size > MINE_CAP };
}

/** Qualifying recommendations this evaluator has already filed, by proposal id. */
async function myRecommendations(db, uid, proposalIds) {
  const filed = new Map();
  const pages = await Promise.all(chunks(proposalIds).map((ids) =>
    db.collection("comments").where("authorId", "==", uid).where("proposalId", "in", ids).get()));
  for (const page of pages) {
    for (const doc of page.docs) {
      const data = doc.data();
      if (data.qualifying !== true || !visibleComment(data)) continue;
      filed.set(data.proposalId, { commentId: doc.id, recommendation: data.recommendation, at: iso(data.createdAt) });
    }
  }
  return filed;
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
  const candidates = [];
  open.forEach((problem, index) => {
    for (const doc of pages[index].docs) {
      const data = doc.data();
      // An evaluator may also author solutions; they cannot recommend their own.
      if (BLOCKED.has(data.moderationStatus) || data.researcherId === uid) continue;
      candidates.push({ doc, data, problem });
    }
  });
  const filed = await myRecommendations(db, uid, candidates.map((row) => row.doc.id));
  const items = candidates.map(({ doc, data, problem }) => {
    const mine = filed.get(doc.id) ?? null;
    return {
      id: doc.id,
      title: data.title ?? "",
      status: data.status ?? "",
      submittedAt: iso(data.createdAt),
      posting: postingView(problem.id, problem.data()),
      recommendationStatus: mine ? "submitted" : "pending",
      recommendation: mine?.recommendation ?? null,
      recommendedAt: mine?.at ?? null,
    };
  }).filter((item) => filter === "all" || item.recommendationStatus === filter);
  const last = problems.docs.at(-1);
  return {
    items,
    filter,
    nextCursor: problems.size === PROBLEM_PAGE && last
      ? { expiresAt: millis(last.data().expiresAt), id: last.id }
      : null,
  };
}
