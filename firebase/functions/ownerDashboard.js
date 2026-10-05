import { HttpsError } from "firebase-functions/v2/https";
import { problemIsMemberBrowsable } from "./moderation.js";
import {
  WORKFLOW_STATUS, opportunityWorkflowStatus, proposalWorkflowStatus, recommendationCounts,
} from "./workflowStatus.js";

/**
 * QCDAO-92 - one roll-up of a problem owner's postings and everything happening
 * on them.
 *
 * Read from the records that already exist, like the other workspace queues.
 * Every solution on every posting this member owns comes back from a single
 * `postingOwnerId` query: that field is the sponsor read ACL (see
 * firestore.rules), so it exists precisely to answer this question without one
 * query per posting.
 *
 * Nothing here touches the chain. Escrow and grant state needs a confirmed
 * block per proposal, which listActionItems already pays for; this module
 * answers the questions that are pure Firestore arithmetic - how many solutions
 * arrived, whether the funding condition is met, and whether the evaluator
 * feedback a decision depends on exists yet.
 */

const LIVE_PROBLEM = new Set(["submitted", "open"]);
// A solution still under consideration: the only kind a decision can act on.
const OPEN_PROPOSAL = new Set(["submitted", "under_review"]);
const BLOCKED = new Set(["hidden", "removed"]);
const CLOSED_POSTING = new Set([WORKFLOW_STATUS.DECISION_RECORDED, WORKFLOW_STATUS.INVALIDATED,
  WORKFLOW_STATUS.DECLINED, WORKFLOW_STATUS.EXPIRED]);
export const OPEN_FUNDING_TYPE = "open-funding";

// Read caps. A total that silently stopped would be worse than no total, so
// anything that hits a cap comes back with `truncated` set and the dashboard
// says so rather than showing a confident wrong number.
export const POSTING_CAP = 200;
export const PROPOSAL_CAP = 400;
// Recommendations shown inline per posting before the card links out instead.
export const LINKED_RECOMMENDATION_CAP = 6;

const fail = (code, message) => { throw new HttpsError(code, message); };
const iso = (value) => value?.toDate?.().toISOString?.() ?? (typeof value === "string" ? value : null);
const minor = (amount) => Math.round((Number(amount) || 0) * 100);

/**
 * Why selection cannot begin on a posting yet, worst first.
 *
 * `owner` blockers are the member's own next move. `external` blockers are
 * someone else's - funders who have not reached the target, evaluators who have
 * not filed - and are labelled that way so the panel never reads as a reproach
 * for work the owner cannot do.
 */
function selectionBlockers({ posting, solutions, workflowStatus }) {
  const blockers = [];
  if (posting.opportunityType === OPEN_FUNDING_TYPE) return blockers;
  if (CLOSED_POSTING.has(workflowStatus)) return blockers;
  if (!solutions.open.length) {
    blockers.push({ kind: "no_solutions", owner: false,
      detail: "No solution has been submitted yet." });
    return blockers;
  }
  if (!solutions.funded.length) {
    blockers.push({ kind: "funding_short", owner: false,
      detail: "No solution has reached its funding target. Selection opens once one is fully funded." });
  }
  if (!solutions.withFeedback.length) {
    blockers.push({ kind: "feedback_missing", owner: false,
      detail: "No evaluator recommendation has been filed. A decision needs at least one." });
  }
  return blockers;
}

/**
 * The arithmetic behind every number on the owner dashboard. Pure on purpose:
 * callers hand it plain records, so a wrong total is a unit test rather than an
 * emulator run.
 */
export function summariseOwnerDashboard({
  problems = [], proposals = [], feedback = new Map(), now = Date.now(), truncated = {},
} = {}) {
  const byProblem = new Map();
  for (const proposal of proposals) {
    if (!proposal.problemId || proposal.status === "draft") continue;
    if (!byProblem.has(proposal.problemId)) byProblem.set(proposal.problemId, []);
    byProblem.get(proposal.problemId).push(proposal);
  }

  const postings = [];
  const accepted = [];
  const blockers = [];
  let proposalsReceived = 0;
  let awaitingFeedback = 0;

  for (const posting of problems) {
    const isDraft = posting.status === "draft";
    const workflowStatus = opportunityWorkflowStatus(posting, new Date(now));
    const rows = (byProblem.get(posting.id) ?? []).filter((row) => !BLOCKED.has(row.moderationStatus) && !row.moderated);
    const solutions = { open: [], funded: [], withFeedback: [], accepted: [] };
    const recommendations = [];
    let recommendationsTotal = 0;
    let fundedMinor = 0;
    let targetMinor = 0;
    const outcomes = [];

    for (const row of rows) {
      const counts = feedback.get(row.id) ?? {};
      const qualifying = Number(counts.qualifying) || 0;
      const rowStatus = proposalWorkflowStatus(row, posting.matching);
      if (rowStatus === WORKFLOW_STATUS.ACCEPTED) {
        solutions.accepted.push(row);
        accepted.push({ proposalId: row.id, title: row.title ?? "", postingId: posting.id,
          postingTitle: posting.title ?? "", amount: row.amount ?? 0, currency: row.currency ?? "",
          escrowBacked: Boolean(row.fundingTerms), acceptedAt: iso(row.updatedAt) });
      }
      if (!OPEN_PROPOSAL.has(row.status)) continue;
      solutions.open.push(row);
      // Funding readiness is a property of the solution, not the posting: the
      // gate mockSelectionState applies is "this solution reached its own
      // target". A posting's requested amount is what it asked for, not what
      // unlocks a decision.
      const rowTarget = minor(row.amount);
      const rowFunded = row.fundingTerms ? 0 : (Number(row.matching?.fundedMinor) || 0);
      targetMinor += rowTarget;
      fundedMinor += rowFunded;
      if (rowTarget > 0 && rowFunded >= rowTarget) solutions.funded.push(row);
      if (qualifying > 0) solutions.withFeedback.push(row);
      else awaitingFeedback += 1;
      recommendationsTotal += qualifying;
      outcomes.push(...(counts.recommendations ?? []));
      for (const comment of counts.recommendationComments ?? []) {
        if (recommendations.length >= LINKED_RECOMMENDATION_CAP) break;
        recommendations.push({ proposalId: row.id, proposalTitle: row.title ?? "", ...comment });
      }
    }

    proposalsReceived += rows.length;
    const postingBlockers = isDraft ? [] : selectionBlockers({ posting, solutions, workflowStatus });
    for (const blocker of postingBlockers) {
      blockers.push({ postingId: posting.id, postingTitle: posting.title ?? "", ...blocker });
    }
    // Live means "still taking decisions". A posting whose deadline has passed
    // or whose winner is recorded keeps status `submitted`, so the workflow
    // status is what separates the two.
    const live = !isDraft && LIVE_PROBLEM.has(posting.status) && problemIsMemberBrowsable(posting)
      && !CLOSED_POSTING.has(workflowStatus);
    postings.push({
      id: posting.id,
      title: posting.title ?? "",
      status: posting.status ?? "",
      workflowStatus,
      opportunityType: posting.opportunityType ?? "business-problem",
      expiresAt: iso(posting.expiresAt),
      updatedAt: iso(posting.updatedAt),
      currency: posting.currency ?? "",
      requestedAmount: posting.amount ?? 0,
      isDraft,
      live,
      proposalsReceived: rows.length,
      openSolutions: solutions.open.length,
      fundedSolutions: solutions.funded.length,
      awaitingFeedback: solutions.open.length - solutions.withFeedback.length,
      qualifyingRecommendations: recommendationsTotal,
      recommendationOutcomes: recommendationCounts(outcomes),
      recommendations,
      // Sum across the posting's open solutions, so the bar answers "how close
      // is this posting to having something selectable" in one number.
      fundingCommitted: fundedMinor / 100,
      fundingTarget: targetMinor / 100,
      fundingPercent: targetMinor > 0 ? Math.min(100, Math.round((fundedMinor / targetMinor) * 100)) : 0,
      readiness: {
        fundingMet: solutions.funded.length > 0,
        feedbackPresent: solutions.withFeedback.length > 0,
        // What mockSelectionState checks, minus the per-solution moderation and
        // self-authorship tests it applies at the moment of selection.
        canSelect: live && posting.opportunityType !== OPEN_FUNDING_TYPE
          && solutions.funded.length > 0 && solutions.withFeedback.length > 0,
        blockers: postingBlockers,
      },
      acceptedProposalId: posting.acceptedProposalId ?? solutions.accepted[0]?.id ?? null,
    });
  }

  // Newest activity first, with drafts after the live postings they would join.
  postings.sort((a, b) => (a.isDraft === b.isDraft ? 0 : a.isDraft ? 1 : -1)
    || (Date.parse(b.updatedAt ?? 0) || 0) - (Date.parse(a.updatedAt ?? 0) || 0));
  accepted.sort((a, b) => (Date.parse(b.acceptedAt ?? 0) || 0) - (Date.parse(a.acceptedAt ?? 0) || 0));

  const live = postings.filter((row) => row.live);
  return {
    postings,
    accepted,
    blockers,
    totals: {
      postings: postings.length,
      drafts: postings.filter((row) => row.isDraft).length,
      live: live.length,
      closed: postings.filter((row) => !row.isDraft && CLOSED_POSTING.has(row.workflowStatus)).length,
      proposalsReceived,
      awaitingFeedback,
      readyToSelect: live.filter((row) => row.readiness.canSelect).length,
      blockedPostings: new Set(blockers.map((row) => row.postingId)).size,
      acceptedSolutions: accepted.length,
    },
    truncated,
    generatedAt: new Date(now).toISOString(),
  };
}

const rows = (snapshot, cap) => snapshot.docs.slice(0, cap).map((doc) => ({ id: doc.id, ...doc.data() }));

/** `readFeedback` is proposalQueues.feedbackByProposal, injected so the counts
 * have one reader and the summariser above stays testable without a database. */
export async function collectOwnerDashboard({ db, uid, readFeedback, now = Date.now() }) {
  if (!uid) fail("unauthenticated", "Sign in to continue.");
  const profile = await db.collection("users").doc(uid).get();
  if (!profile.exists || profile.data().suspended) fail("permission-denied", "An active member profile is required.");
  const [owned, received] = await Promise.all([
    db.collection("problems").where("ownerId", "==", uid).limit(POSTING_CAP + 1).get(),
    db.collection("proposals").where("postingOwnerId", "==", uid).limit(PROPOSAL_CAP + 1).get(),
  ]);
  const problems = rows(owned, POSTING_CAP);
  const ownedIds = new Set(problems.map((problem) => problem.id));
  // A proposal whose parent fell outside the posting page would otherwise be
  // counted against a posting this response never describes.
  const proposals = rows(received, PROPOSAL_CAP).filter((row) => ownedIds.has(row.problemId));
  const feedback = await readFeedback(db, proposals.filter((row) => row.status !== "draft").map((row) => row.id));
  return summariseOwnerDashboard({
    problems,
    proposals,
    feedback,
    now,
    truncated: { postings: owned.size > POSTING_CAP, proposals: received.size > PROPOSAL_CAP },
  });
}
