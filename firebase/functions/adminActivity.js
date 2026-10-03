import { ROLE_ADMIN, ROLE_EVALUATOR } from "./comments.js";
import { problemIsMemberBrowsable } from "./moderation.js";
import { WORKFLOW_STATUS, proposalWorkflowStatus } from "./workflowStatus.js";

/**
 * QCDAO-140 - what the platform is actually doing right now, for the one role
 * with no workspace of its own.
 *
 * Counted from the records that already exist. Nothing new is stored, and the
 * split between reading and counting is deliberate: summariseActivity is pure,
 * so the arithmetic every number on the dashboard depends on can be tested
 * against plain objects rather than a database.
 *
 * Distinct from adminGetPlatformStatus, which answers "are the dependencies
 * healthy" - RPC, contract, Alchemy, Firestore. This answers "what is on the
 * platform", and the two are deliberately not merged: an outage and an empty
 * marketplace are different problems with different fixes.
 */

// Access levels, not stakeholder capabilities. Every account is created as 0;
// 1 and 2 are granted only through the Admin SDK. See frontend/src/lib/roles.js.
export const ACCESS_LEVELS = Object.freeze([
  [0, "user"],
  [ROLE_EVALUATOR, "evaluator"],
  [ROLE_ADMIN, "administrator"],
]);

const LIVE_PROBLEM = new Set(["submitted", "open"]);
const OPEN_PROPOSAL = new Set(["submitted", "under_review"]);
const BLOCKED = new Set(["hidden", "removed"]);
// proposalWorkflowStatus resolves an owner's pick to SELECTED; PENDING_APPROVAL
// is carried here too because the escrow path can report it.
const IN_SELECTION = new Set([WORKFLOW_STATUS.SELECTED, WORKFLOW_STATUS.PENDING_APPROVAL]);

// Read caps. A count that silently stops at the cap would be worse than no
// count, so every total that hits one is reported with `truncated` set and the
// dashboard says so rather than showing a confident wrong number.
export const SCAN_CAP = 1000;

const toMillis = (value) => value?.toMillis?.() ?? (value ? Date.parse(value) : NaN);

function postingIsActive(problem, nowMillis) {
  if (!LIVE_PROBLEM.has(problem.status)) return false;
  if (!problemIsMemberBrowsable(problem)) return false;
  const expires = toMillis(problem.expiresAt);
  return Number.isNaN(expires) || expires > nowMillis;
}

/** A visible, top-level comment carrying one of the three recommendation outcomes. */
function qualifyingRecommendation(comment) {
  return comment.qualifying === true
    && !comment.deletedAt
    && !BLOCKED.has(comment.moderationStatus);
}

/**
 * The arithmetic behind every tile. Pure on purpose: callers hand it arrays of
 * plain records, so a wrong total is a unit test rather than an emulator run.
 */
export function summariseActivity({
  users = [], problems = [], proposals = [], comments = [],
  moderationPending = 0, anchorJobs = [], now = Date.now(), truncated = {},
} = {}) {
  const usersByRole = Object.fromEntries(ACCESS_LEVELS.map(([, name]) => [name, 0]));
  let suspended = 0;
  for (const user of users) {
    const level = ACCESS_LEVELS.find(([value]) => value === user.role) ?? ACCESS_LEVELS[0];
    usersByRole[level[1]] += 1;
    if (user.suspended) suspended += 1;
  }

  const live = problems.filter((problem) => postingIsActive(problem, now));
  const liveIds = new Set(live.map((problem) => problem.id));
  const byProblem = new Map(problems.map((problem) => [problem.id, problem]));

  let openProposals = 0;
  let selectionsInProgress = 0;
  // A posting is gated while any live solution on it still has no qualifying
  // recommendation. `matching.evaluationComplete` is the same flag the owner's
  // selection path reads (see mockSelectionState and ownerReviews), so this
  // counts exactly the postings an owner cannot yet take to a decision.
  const gatedPostings = new Set();
  for (const proposal of proposals) {
    if (BLOCKED.has(proposal.moderationStatus)) continue;
    if (IN_SELECTION.has(proposalWorkflowStatus(proposal, byProblem.get(proposal.problemId)?.matching))) {
      selectionsInProgress += 1;
    }
    if (!OPEN_PROPOSAL.has(proposal.status)) continue;
    openProposals += 1;
    if (proposal.matching?.evaluationComplete !== true && liveIds.has(proposal.problemId)) {
      gatedPostings.add(proposal.problemId);
    }
  }

  const escrow = proposals.reduce((totals, proposal) => {
    // Escrow targets are exact on-chain base units, so they are summed as
    // BigInt and returned as a string. Converting to a JS number here would
    // quietly lose precision on a figure the contract treats as exact.
    if (proposal.fundingTerms?.target) {
      try { totals.escrowTargetBase = (BigInt(totals.escrowTargetBase) + BigInt(proposal.fundingTerms.target)).toString(); }
      catch { /* A malformed target is not a reason to fail the whole dashboard. */ }
      totals.escrowBackedProposals += 1;
    }
    totals.mockFundedMinor += Number(proposal.matching?.fundedMinor) || 0;
    return totals;
  }, { escrowTargetBase: "0", escrowBackedProposals: 0, mockFundedMinor: 0 });

  return {
    users: { total: users.length, byRole: usersByRole, suspended },
    postings: { active: live.length, total: problems.length, feedbackGatesOutstanding: gatedPostings.size },
    proposals: { open: openProposals, total: proposals.length, selectionsInProgress },
    evaluatorFeedback: { qualifyingComments: comments.filter(qualifyingRecommendation).length },
    moderation: { pending: moderationPending },
    anchoring: { failed: anchorJobs.filter((job) => job.status === "failed").length },
    escrow: {
      backedProposals: escrow.escrowBackedProposals,
      targetBaseUnits: escrow.escrowTargetBase,
      mockFunded: escrow.mockFundedMinor / 100,
    },
    truncated,
    generatedAt: new Date(now).toISOString(),
  };
}

const rows = (snapshot) => snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

export async function collectAdminActivity({ db, now = Date.now(), cap = SCAN_CAP }) {
  const [users, problems, proposals, comments, stats, anchorJobs] = await Promise.all([
    db.collection("users").limit(cap).get(),
    db.collection("problems").limit(cap).get(),
    db.collection("proposals").limit(cap).get(),
    db.collection("comments").where("qualifying", "==", true).limit(cap).get(),
    db.collection("moderationStats").doc("global").get(),
    db.collection("proposalAuditJobs").where("status", "==", "failed").limit(cap).get(),
  ]);
  const atCap = (snapshot) => snapshot.size >= cap;
  return summariseActivity({
    users: rows(users),
    problems: rows(problems),
    proposals: rows(proposals),
    comments: rows(comments),
    moderationPending: Number(stats.data()?.pendingCount) || 0,
    anchorJobs: rows(anchorJobs),
    now,
    truncated: {
      users: atCap(users), postings: atCap(problems), proposals: atCap(proposals),
      comments: atCap(comments), anchoring: atCap(anchorJobs),
    },
  });
}
