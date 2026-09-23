import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { canReadContent } from "./moderation.js";
import { mockSelectionState } from "./matching.js";

const PROPOSAL_CAP = 200;
const VISIBLE_STATUS = ["submitted", "under_review", "accepted", "rejected", "withdrawn"];
const BLOCKED = new Set(["hidden", "removed"]);
const fail = (code, message) => { throw new HttpsError(code, message); };

function validId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail("invalid-argument", "Invalid problem.");
}

function whole(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function recommendationCounts(data = {}) {
  return {
    recommend: whole(data.recommend),
    recommend_with_revisions: whole(data.recommend_with_revisions),
    do_not_recommend: whole(data.do_not_recommend),
  };
}

function selectionHint(viewerIsOwner, selection) {
  if (!viewerIsOwner || selection.canSelect || !selection.open || !selection.eligible) return null;
  if (!selection.feedbackOpen && !selection.fundingMet) return "Needs full funding and a qualifying evaluator recommendation.";
  if (!selection.feedbackOpen) return "Needs a qualifying evaluator recommendation.";
  if (!selection.fundingMet) return "Needs full funding.";
  return null;
}

export async function getProposalComparison({ db, uid, problemId, now = Timestamp.now() }) {
  validId(problemId);
  if (!uid) fail("unauthenticated", "Sign in to continue.");
  const context = await db.runTransaction(async (tx) => {
    const profile = await tx.get(db.collection("users").doc(uid));
    if (!profile.exists || profile.data().suspended) fail("permission-denied", "An active member profile is required.");
    const problem = await tx.get(db.collection("problems").doc(problemId));
    if (!problem.exists || !await canReadContent(tx, db, "problem", problem.data(), uid, profile.data())) {
      fail("permission-denied", "This opportunity is not available.");
    }
    return problem.data();
  });
  const found = await db.collection("proposals").where("problemId", "==", problemId)
    .where("status", "in", VISIBLE_STATUS).limit(PROPOSAL_CAP + 1).get();
  const visible = found.docs.filter((doc) => !BLOCKED.has(doc.data().moderationStatus)).slice(0, PROPOSAL_CAP);
  const [summaries, profiles] = await Promise.all([
    Promise.all(visible.map((doc) => db.collection("proposalFeedbackSummaries").doc(doc.id).get())),
    Promise.all([...new Set(visible.map((doc) => String(doc.data().researcherId || "").toLowerCase()).filter(Boolean))]
      .map(async (id) => [id, await db.collection("publicProfiles").doc(id).get()])),
  ]);
  const names = new Map(profiles.map(([id, snap]) => [id, snap.exists ? snap.data() : {}]));
  const viewerIsOwner = context.ownerId === uid;
  const rows = visible.map((doc, index) => {
    const proposal = doc.data();
    const selection = mockSelectionState({ problem: context, proposal: { id: doc.id, ...proposal }, uid, at: now });
    const summary = summaries[index].exists ? summaries[index].data() : {};
    const recommendations = recommendationCounts(summary);
    const developer = names.get(String(proposal.researcherId || "").toLowerCase()) || {};
    return {
      id: doc.id,
      title: proposal.title || "Untitled proposal",
      developerName: String(developer.fullName || "").slice(0, 200),
      organisation: String(developer.organisation || "").slice(0, 200),
      category: proposal.category || "",
      amount: proposal.amount ?? null,
      currency: proposal.currency || "",
      status: proposal.status,
      fundedAmount: selection.fundedAmount,
      matching: { status: selection.state, evaluationComplete: selection.feedbackOpen },
      recommendations,
      qualifyingCount: whole(summary.qualifyingCount),
      commentCount: whole(summary.commentCount),
      canSelect: selection.canSelect,
      selectionHint: selectionHint(viewerIsOwner, selection),
    };
  }).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return {
    problemId,
    viewerIsOwner,
    advisory: true,
    truncated: found.size > PROPOSAL_CAP,
    problemMatching: {
      status: context.matching?.status || "open",
      proposalId: context.matching?.proposalId || null,
    },
    rows,
  };
}
