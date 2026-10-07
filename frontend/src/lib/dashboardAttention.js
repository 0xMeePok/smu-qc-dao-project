import { isExpired } from "./datetime.js";

/**
 * QCDAO-92/93 - the attention panel on both role dashboards.
 *
 * Built from the QCDAO-91 action-items payload rather than from a second
 * aggregation. That payload already costs a confirmed-block escrow read per
 * proposal, and `useActionItems` already shares one copy of it across the
 * workspace tab count and every page that asks. Re-deriving it per dashboard
 * would pay for the same chain reads twice and could disagree with the tab
 * count the member is looking at.
 */

// Owner-side escrow steps are keyed apart from the solution author's so each
// dashboard shows only what its own role can actually do.
const OWNER_ESCROW = {
  select: { heading: "Ready to select", cta: "Open escrow selection",
    note: "Fully funded. Selecting records your approval and opens the author's acceptance window." },
  approve_upfront: { heading: "Upfront payment to approve", dual: true, cta: "Open upfront approval",
    note: "Both parties must approve before any payment is released." },
  approve_delivery: { heading: "Delivery to approve", dual: true, cta: "Open delivery approval",
    note: "The author has submitted evidence. Both parties must approve the release." },
};

const AUTHOR_ESCROW = {
  approve_upfront: { heading: "Upfront payment to approve", dual: true, cta: "Open upfront approval",
    note: "Both parties must approve before any payment is released." },
  approve_delivery: { heading: "Delivery to approve", dual: true, cta: "Open delivery approval",
    note: "Both parties must approve the release." },
  submit_delivery: { heading: "Delivery evidence to submit", cta: "Open escrow",
    note: "The escrow is waiting on your evidence before the final tranche can be approved." },
};

const escrowBacked = (item) => Object.hasOwn(item ?? {}, "fundingTerms");
const time = (value) => (value ? Date.parse(value) : NaN);

/** Where a member acts on this record: the escrow screen, or the posting's match panel. */
function route(item, { tab = "funding", preferPosting = false } = {}) {
  if (!preferPosting || escrowBacked(item)) return `proposal/${item.id}?tab=${tab}`;
  return item.problemId ? `posting/${item.problemId}?tab=funding` : `proposal/${item.id}?tab=${tab}`;
}

/**
 * Soonest deadline first: a lapsed acceptance window invalidates the posting
 * and refunds its funders, so it is the only thing on these dashboards that
 * gets worse by being ignored. Items with no deadline follow, newest first.
 */
export function byUrgency(items = []) {
  return [...items].sort((a, b) => {
    const left = time(a.deadlineAt);
    const right = time(b.deadlineAt);
    if (Number.isNaN(left) !== Number.isNaN(right)) return Number.isNaN(left) ? 1 : -1;
    if (!Number.isNaN(left) && left !== right) return left - right;
    return (time(b.submittedAt) || 0) - (time(a.submittedAt) || 0);
  });
}

function entry({ item, kind, heading, note, cta, target, dual = false }) {
  return {
    key: `${kind}-${item.id}`,
    kind,
    heading,
    note,
    cta,
    dual,
    route: target,
    id: item.id,
    title: item.title || "Untitled",
    postingTitle: item.posting?.title || "",
    deadlineAt: item.deadlineAt ?? null,
    submittedAt: item.submittedAt ?? null,
    workflowStatus: item.workflowStatus ?? null,
  };
}

/** QCDAO-92. What is blocked on the owner, across their postings. */
export function ownerAttention(actions, postingIds = new Set()) {
  const items = [];
  for (const item of actions?.owner?.readyToSelect ?? []) {
    items.push(entry({ item, kind: "select", heading: "Ready to select", cta: "Open selection",
      note: "Fully funded with evaluator feedback on file. Selecting opens the author's acceptance window.",
      target: route(item, { preferPosting: true }) }));
  }
  for (const item of actions?.owner?.awaitingReview ?? []) {
    items.push(entry({ item, kind: "review", heading: "Awaiting my review", cta: "Open feedback",
      note: "Written feedback only. It does not select or reject a solution.",
      target: `proposal/${item.id}?tab=feedback` }));
  }
  for (const item of actions?.escrowActions ?? []) {
    const shape = OWNER_ESCROW[item.action];
    // The payload mixes both sides of an escrow. A posting this member owns is
    // what makes the step theirs as the owner.
    if (!shape || !postingIds.has(item.problemId)) continue;
    items.push(entry({ item, kind: `escrow-${item.action}`, heading: shape.heading, note: shape.note,
      cta: shape.cta, dual: Boolean(shape.dual), target: `proposal/${item.id}?tab=funding` }));
  }
  return byUrgency(items);
}

/** QCDAO-93. What is blocked on the solution author, dual approvals first. */
export function developerAttention(actions, proposalIds = new Set()) {
  const items = [];
  for (const item of actions?.researcher?.selectionToAccept ?? []) {
    items.push(entry({ item, kind: "accept", heading: "Selection to accept", dual: true,
      cta: "Open acceptance",
      note: "An owner selected your solution. Both parties must accept before funding locks; a missed deadline invalidates the posting.",
      target: route(item, { preferPosting: true }) }));
  }
  for (const item of actions?.researcher?.grantSelectionsToAccept ?? []) {
    items.push(entry({ item, kind: "grant", heading: "Grant offer to accept", cta: "Accept grant",
      note: "The grant owner reserved funding for this solution. Acceptance funds its escrow.",
      target: `proposal/${item.id}?tab=funding` }));
  }
  for (const item of actions?.escrowActions ?? []) {
    const shape = AUTHOR_ESCROW[item.action];
    // A proposal this member authored is what makes the step theirs.
    if (!shape || !proposalIds.has(item.id)) continue;
    items.push(entry({ item, kind: `escrow-${item.action}`, heading: shape.heading, note: shape.note,
      cta: shape.cta, dual: Boolean(shape.dual), target: `proposal/${item.id}?tab=funding` }));
  }
  return byUrgency(items);
}

/**
 * Pending funding approaches still waiting on this researcher's accept or decline.
 * A lapsed approach is already expired and is not an action. The detail page is `approach/{id}`.
 */
export function fundingApproachAttention(approaches = [], now = new Date()) {
  const items = [];
  for (const approach of approaches) {
    if (approach?.status !== "pending" || isExpired(approach.expiresAt, now)) continue;
    const amount = `${approach.currency || ""} ${Number(approach.amount ?? 0).toLocaleString()}`.trim();
    const funder = approach.funderName || "A client or funder";
    items.push({
      key: `approach-${approach.id}`,
      kind: "funding-approach",
      heading: "Funding approach to answer",
      note: `${funder} offered ${amount} indicative. Accept or decline before it expires. This does not deposit tokens.`,
      cta: "Open approach",
      dual: false,
      route: `approach/${approach.id}`,
      id: approach.id,
      title: approach.proposalTitle || "Independent listing",
      postingTitle: "",
      deadlineAt: approach.expiresAt ?? null,
      submittedAt: approach.createdAt ?? null,
      workflowStatus: null,
    });
  }
  return items;
}

/** Why a posting cannot reach a decision, in the words of whoever must act. */
export const BLOCKER_LABELS = Object.freeze({
  no_solutions: "No solutions yet",
  funding_short: "Funding target not reached",
  feedback_missing: "Evaluator feedback outstanding",
});

/**
 * QCDAO-93. Ordinary discussion on a solution: every visible comment that is
 * not a qualifying evaluator recommendation. Counted apart so a question from
 * the owner is never read as a filing, and a filing never inflates the thread.
 */
export function discussionCountLabel(row) {
  const count = Math.max(0, (row?.comments ?? 0) - (row?.qualifying ?? 0));
  return count === 1 ? "1 discussion comment" : `${count} discussion comments`;
}
