import { RESPONSE_OPEN_STATUSES, deadlinePassed } from "./opportunityExpiry.js";

/** QCDAO-91. The one status vocabulary; functions and the frontend both import it. */
export const WORKFLOW_STATUS = Object.freeze({
  DRAFT: "draft",
  SUBMITTED: "submitted",
  AWAITING_EVALUATOR_FEEDBACK: "awaiting_evaluator_feedback",
  SELECTED: "selected",
  PENDING_APPROVAL: "pending_approval",
  ACCEPTED: "accepted",
  DECISION_RECORDED: "decision_recorded",
  INVALIDATED: "invalidated",
  DECLINED: "declined",
  EXPIRED: "expired",
  REFUNDED: "refunded",
  RECOMMEND: "recommend",
  RECOMMEND_WITH_REVISIONS: "recommend_with_revisions",
  DO_NOT_RECOMMEND: "do_not_recommend",
  EVALUATIONS: "evaluations",
  FEEDBACK_RECORDED: "feedback_recorded",
  REVISION_REQUESTED: "revision_requested",
  NOT_PROGRESSING: "not_progressing",
});

const S = WORKFLOW_STATUS;

// Label, colour tone, icon, what it means and what happens next.
export const WORKFLOW_STATUS_DETAILS = Object.freeze({
  [S.DRAFT]: { label: "Draft", tone: "neutral", icon: "draft",
    description: "Saved privately. Only its author can see it.",
    next: "Complete every required field, then submit it." },
  [S.SUBMITTED]: { label: "Submitted", tone: "info", icon: "submitted",
    description: "Live on the platform and open to proposals, funding and evaluator feedback.",
    next: "It stays open until a fully funded proposal is selected or the deadline passes." },
  [S.AWAITING_EVALUATOR_FEEDBACK]: { label: "Awaiting evaluator feedback", tone: "warning", icon: "hourglass",
    description: "No assigned evaluator has recommended this proposal yet.",
    next: "Evaluators may add recommendations. They are advisory: the owner can select without one." },
  [S.SELECTED]: { label: "Selected", tone: "warning", icon: "selected",
    description: "The owner chose this fully funded proposal and recorded their approval.",
    next: "Its creator accepts or rejects it before the acceptance deadline." },
  [S.PENDING_APPROVAL]: { label: "Pending approval", tone: "warning", icon: "clock",
    description: "A match or pledge is waiting on the remaining party's approval.",
    next: "Funding locks once both parties accept. A rejection or a missed deadline refunds funders." },
  [S.ACCEPTED]: { label: "Accepted", tone: "success", icon: "check",
    description: "Both parties approved the match and its funding is locked.",
    next: "Work proceeds against the proposal's milestones." },
  [S.DECISION_RECORDED]: { label: "Decision recorded", tone: "success", icon: "record",
    description: "The match is final and written to the decision record.",
    next: "No further selection happens. Other proposals close and their funders are refunded." },
  [S.INVALIDATED]: { label: "Invalidated", tone: "danger", icon: "invalid",
    description: "Closed because the acceptance window lapsed or a moderator intervened.",
    next: "Outstanding funding was refunded. Nothing further can be selected." },
  [S.DECLINED]: { label: "Declined", tone: "danger", icon: "declined",
    description: "Rejected or withdrawn by one of its parties.",
    next: "Any funding pledged to it was refunded. It can no longer be selected." },
  [S.EXPIRED]: { label: "Expired", tone: "muted", icon: "expired",
    description: "Its deadline passed before the workflow finished.",
    next: "It no longer accepts proposals, funding or selection." },
  [S.REFUNDED]: { label: "Refunded", tone: "muted", icon: "refunded",
    description: "Another outcome closed it and its funding was returned.",
    next: "Funders have their contributions back. Nothing further happens." },
  [S.RECOMMEND]: { label: "Recommend", tone: "success", icon: "thumbs-up",
    description: "An evaluator recommends this proposal as submitted.",
    next: "Advisory only: the owner still decides which proposal to select." },
  [S.RECOMMEND_WITH_REVISIONS]: { label: "Recommend with revisions", tone: "warning", icon: "revise",
    description: "An evaluator recommends this proposal subject to the changes they describe.",
    next: "Advisory only: the owner still decides which proposal to select." },
  [S.DO_NOT_RECOMMEND]: { label: "Do not recommend", tone: "danger", icon: "thumbs-down",
    description: "An evaluator advises against this proposal.",
    next: "Advisory only: the owner can still select it." },
  [S.EVALUATIONS]: { label: "Combined evaluations", tone: "warning", icon: "thumbs-up",
    description: "Several evaluators recommended this proposal; the icons show which outcomes they gave.",
    next: "Advisory only: the owner still decides which proposal to select." },
  [S.FEEDBACK_RECORDED]: { label: "Feedback recorded", tone: "info", icon: "record",
    description: "The problem owner left written feedback on this proposal.",
    next: "Nothing is required of the researcher. Selection is a separate step." },
  [S.REVISION_REQUESTED]: { label: "Revision requested", tone: "warning", icon: "revise",
    description: "The problem owner asked the researcher to revise this proposal.",
    next: "The researcher edits and resubmits it while editing is still open." },
  [S.NOT_PROGRESSING]: { label: "Not progressing", tone: "muted", icon: "declined",
    description: "The problem owner recorded that this proposal is not progressing.",
    next: "It stays visible, but the owner does not intend to select it." },
});

export const RECOMMENDATION_STATUSES = Object.freeze([S.RECOMMEND, S.RECOMMEND_WITH_REVISIONS, S.DO_NOT_RECOMMEND]);

const OUTCOME_PHRASE = Object.freeze({
  [S.RECOMMEND]: "recommended", [S.RECOMMEND_WITH_REVISIONS]: "recommended with revisions",
  [S.DO_NOT_RECOMMEND]: "did not recommend",
});

/** A proposal's evaluator feedback as one badge: none, a single outcome, or a combined summary. */
export function evaluationSummary(counts = {}) {
  const present = RECOMMENDATION_STATUSES.filter((status) => (counts?.[status] || 0) > 0);
  const total = present.reduce((sum, status) => sum + counts[status], 0);
  if (total === 0) return { total, status: S.AWAITING_EVALUATOR_FEEDBACK };
  if (total === 1) return { total, status: present[0] };
  // One icon per outcome given; a lone outcome shows twice, e.g. two thumbs up.
  const only = present.length === 1 ? present[0] : null;
  const icons = present.map((status) => WORKFLOW_STATUS_DETAILS[status].icon);
  return { total, status: S.EVALUATIONS,
    icons: only ? [icons[0], icons[0]] : icons,
    tone: only === S.RECOMMEND ? "success" : only === S.DO_NOT_RECOMMEND ? "danger" : "warning",
    text: `${total} evaluations`,
    breakdown: present.map((status) => `${counts[status]} ${OUTCOME_PHRASE[status]}`).join(" · ") };
}

const OWNER_REVIEW_STATUS = Object.freeze({
  feedback: S.FEEDBACK_RECORDED, revision_requested: S.REVISION_REQUESTED, not_progressing: S.NOT_PROGRESSING,
});

const key = (value) => String(value ?? "").trim().toLowerCase();

export function workflowStatusDetails(status) {
  return WORKFLOW_STATUS_DETAILS[key(status)] ?? null;
}

export function workflowStatusLabel(status) {
  return workflowStatusDetails(status)?.label ?? "";
}

/** Stored problem/opportunity state -> workflow status. */
export function opportunityWorkflowStatus(problem = {}, now = new Date()) {
  const status = key(problem?.status);
  const matching = key(problem?.matching?.status);
  if (status === "draft") return S.DRAFT;
  if (matching === "invalidated") return S.INVALIDATED;
  if (matching === "confirmed" || ["matched", "funded", "completed"].includes(status)) return S.DECISION_RECORDED;
  if (matching === "awaiting_confirmation") return S.PENDING_APPROVAL;
  if (status === "cancelled") return S.DECLINED;
  if (status === "expired" || (RESPONSE_OPEN_STATUSES.has(status) && deadlinePassed(problem?.expiresAt, now))) return S.EXPIRED;
  return S.SUBMITTED;
}

/** Stored proposal state, read with its parent's matching state -> workflow status. */
export function proposalWorkflowStatus(proposal = {}, problemMatching = proposal?.problemMatching) {
  const status = key(proposal?.status);
  // Escrow lifecycle comes from the contract, never a legacy mock match or sibling.
  const escrow = Object.hasOwn(proposal || {}, "fundingTerms");
  const own = escrow ? "" : key(proposal?.matching?.status);
  const parent = escrow ? "" : key(problemMatching?.status);
  if (status === "draft") return S.DRAFT;
  if (["withdrawn", "rejected"].includes(status) || own === "declined") return S.DECLINED;
  if (own === "awaiting_confirmation") return S.SELECTED;
  if (own === "confirmed" || status === "accepted") return S.ACCEPTED;
  if (["voided", "invalidated"].includes(own) || parent === "invalidated") return S.INVALIDATED;
  if (own === "cancelled" || parent === "confirmed") return S.REFUNDED;
  return S.SUBMITTED;
}

/** A funding contribution's stored state -> workflow status. */
export function contributionWorkflowStatus(status) {
  const value = key(status);
  if (value === "refunded") return S.REFUNDED;
  if (["locked", "approved", "disbursing"].includes(value)) return S.ACCEPTED;
  if (value === "completed") return S.DECISION_RECORDED;
  return S.PENDING_APPROVAL;
}

export function ownerReviewWorkflowStatus(outcome) {
  return OWNER_REVIEW_STATUS[key(outcome)] ?? null;
}

const EVENT_STATUS = Object.freeze({
  owner_selected: S.SELECTED,
  owner_confirmed: S.PENDING_APPROVAL,
  creator_confirmed: S.PENDING_APPROVAL,
  funding_contributed: S.PENDING_APPROVAL,
  match_confirmed: S.DECISION_RECORDED,
  owner_declined: S.DECLINED,
  creator_declined: S.DECLINED,
  confirmation_expired: S.INVALIDATED,
  admin_force_expired: S.INVALIDATED,
  posting_expired: S.INVALIDATED,
  posting_invalidated: S.INVALIDATED,
  posting_reopened: S.SUBMITTED,
  funding_target_reached: S.SUBMITTED,
  moderation_refunded: S.REFUNDED,
  opportunity_expired: S.EXPIRED,
});

const EVENT_LABELS = Object.freeze({
  owner_selected: "Owner selected a proposal",
  owner_confirmed: "Owner accepted",
  creator_confirmed: "Creator accepted",
  funding_contributed: "Funding pledged",
  funding_target_reached: "Funding target reached",
  match_confirmed: "Match confirmed",
  owner_declined: "Owner rejected the selection",
  creator_declined: "Creator rejected the selection",
  confirmation_expired: "Acceptance window lapsed",
  admin_force_expired: "Acceptance window expired by an administrator",
  posting_expired: "Posting deadline lapsed",
  posting_invalidated: "Posting invalidated",
  posting_reopened: "Posting reopened",
  moderation_refunded: "Refunded after moderation",
  mock_evaluation_completed: "Mock evaluation recorded",
  opportunity_expired: "Opportunity expired",
});

/** Decision-record and notification events -> the status they leave behind, or null. */
export function eventWorkflowStatus(type) {
  return EVENT_STATUS[key(type)] ?? null;
}

export function eventLabel(type) {
  return EVENT_LABELS[key(type)] ?? "Workflow event";
}

const NOTICE_STATUS = Object.freeze({ proposal_received: S.SUBMITTED, approval_nearing_expiry: S.PENDING_APPROVAL });

/** A member notice's status; older notices predate the stored field. */
export function noticeWorkflowStatus(notice = {}) {
  return notice?.workflowStatus || eventWorkflowStatus(notice?.eventType) || NOTICE_STATUS[notice?.kind] || null;
}

// Legacy proposals carry the pre-QCDAO-91 single holder instead of the map.
/** Every evaluator's recommendation on a proposal, keyed by evaluator id. */
export function recommendationEntries(proposal = {}) {
  const matching = proposal?.matching || {};
  const entries = { ...(matching.recommendations || {}) };
  if (matching.recommendedBy && !entries[matching.recommendedBy] && matching.recommendation) {
    entries[matching.recommendedBy] = { commentId: matching.recommendationCommentId ?? null,
      recommendation: matching.recommendation };
  }
  return entries;
}

/** Recommendation counts by outcome. */
export function recommendationCounts(source) {
  const counts = Object.fromEntries(RECOMMENDATION_STATUSES.map((value) => [value, 0]));
  const values = Array.isArray(source)
    ? source
    : Object.values(recommendationEntries(source)).map((entry) => entry?.recommendation);
  for (const value of values) if (value in counts) counts[value] += 1;
  return counts;
}
