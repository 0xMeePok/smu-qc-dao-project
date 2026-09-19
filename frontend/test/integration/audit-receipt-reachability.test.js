import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { evaluateRouteAccess } from "../../src/config/routes.js";
import {
  VERIFIED_STATES,
  verifiedStateFromAudit,
} from "../../src/config/verifiedBadge.js";
import { formatInstant, toDate } from "../../src/lib/datetime.js";
import { ROLE_ADMIN, ROLE_USER, capabilitiesForAccessLevel } from "../../src/lib/roles.js";
import { memoryDb } from "../../../firebase/functions/test/memoryDb.mjs";
import { getModerationContext, submitContentReport } from "../../../firebase/functions/moderation.js";

/** View an audit receipt — timestamp fallback and cross-surface reachability. */

const require = createRequire(new URL("../../../firebase/functions/package.json", import.meta.url));
const { Timestamp } = require("firebase-admin/firestore");
const now = Timestamp.fromMillis(1_800_000_000_000);

const KIND = Object.freeze({
  PROPOSAL: "proposal",
  LISTING: "listing",
  COMMENT: "comment",
});

const RECOMMENDATION_LABELS = {
  recommend: "Recommend",
  recommend_with_revisions: "Recommend with revisions",
  do_not_recommend: "Do not recommend",
};

const MATCHING_AUDIT_EVENTS = ["owner_selected", "owner_confirmed", "creator_confirmed", "match_confirmed"];

function chainInstant(value) {
  if (value == null || value === "") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

function receiptInstant(chainTimestamp, recordTimestamp) {
  return chainInstant(chainTimestamp) ?? toDate(recordTimestamp);
}

/** Mirrors AuditReceipt: one timestamp field, verification from the stored receipt only. */
function receiptView({ audit, chainTimestamp, recordTimestamp, firebaseReference, eventLabel }) {
  const timestamp = receiptInstant(chainTimestamp, recordTimestamp);
  return {
    eventLabel,
    firebaseReference,
    timestamp: timestamp ? formatInstant(timestamp) : "Not available",
    verification: verifiedStateFromAudit(audit),
  };
}

/** Mirrors RelatedAuditReceiptPane: comments stay off-chain and never get a verification chip. */
function relatedReceiptView({ kind, record, comment }) {
  if (kind === KIND.COMMENT) {
    return {
      showsAuditReceipt: false,
      verification: null,
      badge: comment?.authorRole === "evaluator" ? "Evaluator" : null,
      recommendation: comment?.qualifying ? (RECOMMENDATION_LABELS[comment.recommendation] || "") : "",
    };
  }
  if (!record) {
    return { showsAuditReceipt: false, verification: verifiedStateFromAudit(null), firebaseReference: null };
  }
  const isOpenFunding = record.opportunityType === "open-funding";
  return {
    showsAuditReceipt: true,
    verification: verifiedStateFromAudit(record.audit, { recordStatus: record.status }),
    firebaseReference: kind === KIND.PROPOSAL ? `proposals/${record.id}` : `problems/${record.id}`,
    eventLabel: kind === KIND.PROPOSAL
      ? "Proposal submitted"
      : isOpenFunding ? "Open funding opportunity submitted" : "Problem statement submitted",
    actorRole: kind === KIND.PROPOSAL
      ? "Researcher / solution developer"
      : isOpenFunding ? "Funder" : "Problem owner",
  };
}

/** Mirrors MatchingPanel + MockFundingPortfolio: off-chain records open the selected proposal receipt. */
function matchingEscrowView({ matching, history = [], confirmed = false, contributions = [] }) {
  const selectedId = matching?.proposalId;
  const opens = history.filter((entry) => MATCHING_AUDIT_EVENTS.includes(entry.type) && entry.proposalId);
  const canOpen = Boolean(selectedId && (
    opens.some((entry) => entry.type === "owner_selected")
    || (matching?.ownerApprovedAt && opens.some((entry) => entry.type === "owner_confirmed" || entry.type === "owner_selected"))
    || (matching?.creatorApprovedAt && opens.some((entry) => entry.type === "creator_confirmed"))
    || (confirmed && opens.some((entry) => entry.type === "match_confirmed"))
  ));
  return {
    offChain: true,
    canOpenSelectedAudit: canOpen,
    auditTarget: canOpen ? { kind: KIND.PROPOSAL, id: selectedId } : null,
    historyTargets: opens.map((entry) => ({ kind: KIND.PROPOSAL, id: entry.proposalId })),
    portfolioTargets: contributions
      .filter((item) => item.proposalId)
      .map((item) => ({ kind: KIND.PROPOSAL, id: item.proposalId })),
  };
}

/** Mirrors ModerationQueue.relatedAuditTarget. */
function relatedAuditTarget(selected, context) {
  if (!selected || !context) return null;
  if (selected.contentType === "comment") {
    const parent = context.parent;
    if (parent?.contentType === "proposal" && parent.id) return { kind: KIND.PROPOSAL, id: parent.id };
    if (parent?.contentType === "problem" && parent.id) return { kind: KIND.LISTING, id: parent.id };
    return null;
  }
  if (selected.contentType === "proposal" && context.content?.id) {
    return { kind: KIND.PROPOSAL, id: context.content.id };
  }
  if (selected.contentType === "problem" && context.content?.id) {
    return { kind: KIND.LISTING, id: context.content.id };
  }
  return null;
}

function governanceRow(item) {
  const isExpiry = item.type === "opportunity_expired";
  const listingId = item.targetId || item.target;
  return {
    showViewReceipt: Boolean(isExpiry && listingId),
    auditTarget: isExpiry && listingId ? { kind: KIND.LISTING, id: listingId } : null,
  };
}

function adminTrail(session) {
  const user = session?.isSignedIn && session?.profile
    ? { roles: capabilitiesForAccessLevel(session.profile.role) }
    : null;
  return evaluateRouteAccess("admin", user);
}

function fixture() {
  return memoryDb({
    "users/admin": { role: 1, fullName: "Moderator", organisation: "DAO" },
    "users/owner": { role: 0, fullName: "Problem owner", organisation: "Industry" },
    "users/alice": { role: 0, fullName: "Alice", organisation: "University" },
    "problems/problem": {
      ownerId: "owner",
      title: "Routing study",
      summary: "Improve routes",
      status: "submitted",
      createdAt: now,
      audit: { status: "confirmed" },
    },
    "proposals/a": {
      researcherId: "alice",
      postingOwnerId: "owner",
      problemId: "problem",
      title: "Proposal A",
      summary: "A routing approach",
      status: "submitted",
      createdAt: now,
      audit: { status: "confirmed" },
    },
    "comments/comment": {
      authorId: "alice",
      problemId: "problem",
      proposalId: "a",
      text: "A community discussion",
      createdAt: now,
    },
  });
}

const report = (db, patch = {}) => submitContentReport({
  db,
  uid: "owner",
  contentType: "proposal",
  contentId: "a",
  reason: "misleading",
  details: "Please check the claimed result.",
  now,
  ...patch,
});

describe("Integration Tests: Audit receipt reachability", () => {
  it("[FIT-BAV-047] should keep timestamp visible without changing verification", () => {
    const recordTime = "2026-09-01T00:00:00.000Z";
    const fallback = receiptView({
      audit: { status: "pending" },
      recordTimestamp: recordTime,
      firebaseReference: "proposals/a",
      eventLabel: "Proposal submitted",
    });
    assert.equal(fallback.timestamp, formatInstant(recordTime));
    assert.notEqual(fallback.timestamp, "Not available");
    assert.equal(fallback.verification, VERIFIED_STATES.PENDING);

    const chain = receiptView({
      audit: { status: "confirmed" },
      chainTimestamp: 1_756_800_000,
      recordTimestamp: recordTime,
      firebaseReference: "proposals/a",
      eventLabel: "Proposal submitted",
    });
    assert.equal(chain.timestamp, formatInstant(new Date(1_756_800_000 * 1000)));
    assert.notEqual(chain.timestamp, formatInstant(recordTime));
    assert.equal(chain.verification, VERIFIED_STATES.VERIFIED);
    assert.notEqual(chain.verification, chain.timestamp);
  });

  it("[FIT-BAV-048] should show comments off-chain beside related receipts", () => {
    const proposal = relatedReceiptView({
      kind: KIND.PROPOSAL,
      record: { id: "a", status: "submitted", audit: { status: "confirmed" } },
    });
    assert.equal(proposal.showsAuditReceipt, true);
    assert.equal(proposal.firebaseReference, "proposals/a");
    assert.equal(proposal.eventLabel, "Proposal submitted");
    assert.equal(proposal.verification, VERIFIED_STATES.VERIFIED);

    const listing = relatedReceiptView({
      kind: KIND.LISTING,
      record: { id: "problem", status: "submitted", opportunityType: "open-funding", audit: { status: "pending" } },
    });
    assert.equal(listing.firebaseReference, "problems/problem");
    assert.equal(listing.eventLabel, "Open funding opportunity submitted");
    assert.equal(listing.actorRole, "Funder");
    assert.equal(listing.verification, VERIFIED_STATES.PENDING);

    const comment = relatedReceiptView({
      kind: KIND.COMMENT,
      comment: { authorRole: "evaluator", qualifying: true, recommendation: "recommend_with_revisions" },
    });
    assert.equal(comment.showsAuditReceipt, false);
    assert.equal(comment.verification, null);
    assert.equal(comment.badge, "Evaluator");
    assert.equal(comment.recommendation, "Recommend with revisions");
    assert.ok(!Object.values(VERIFIED_STATES).includes(comment.recommendation));
  });

  it("[FIT-BAV-049] should open one proposal receipt from matching escrow", () => {
    const history = [
      { type: "owner_selected", proposalId: "a" },
      { type: "creator_confirmed", proposalId: "a" },
      { type: "match_confirmed", proposalId: "a" },
      { type: "funding_contributed", proposalId: "a" },
    ];
    const view = matchingEscrowView({
      matching: {
        proposalId: "a",
        ownerApprovedAt: "2026-09-15T00:00:00Z",
        creatorApprovedAt: "2026-09-16T00:00:00Z",
      },
      history,
      confirmed: true,
      contributions: [{ proposalId: "a", status: "locked" }, { proposalId: "a", status: "refunded" }],
    });
    assert.equal(view.offChain, true);
    assert.equal(view.canOpenSelectedAudit, true);
    assert.deepEqual(view.auditTarget, { kind: KIND.PROPOSAL, id: "a" });
    assert.ok(view.historyTargets.every((target) => target.kind === KIND.PROPOSAL && target.id === "a"));
    assert.equal(view.historyTargets.length, 3);
    assert.ok(view.portfolioTargets.every((target) => target.kind === KIND.PROPOSAL && target.id === "a"));
    assert.equal(view.portfolioTargets.length, 2);
  });

  it("[FIT-BAV-050] should map moderation items to the related receipt", async () => {
    const db = fixture();
    await report(db);
    const proposalContext = await getModerationContext({ db, uid: "admin", queueId: "proposal_a" });
    assert.equal(proposalContext.content.id, "a");
    assert.deepEqual(
      relatedAuditTarget({ contentType: "proposal" }, proposalContext),
      { kind: KIND.PROPOSAL, id: "a" },
    );

    await report(db, { contentType: "problem", contentId: "problem" });
    const listingContext = await getModerationContext({ db, uid: "admin", queueId: "problem_problem" });
    assert.deepEqual(
      relatedAuditTarget({ contentType: "problem" }, listingContext),
      { kind: KIND.LISTING, id: "problem" },
    );

    await report(db, { contentType: "comment", contentId: "comment" });
    const commentContext = await getModerationContext({ db, uid: "admin", queueId: "comment_comment" });
    assert.equal(commentContext.parent.contentType, "proposal");
    assert.equal(commentContext.parent.id, "a");
    assert.deepEqual(
      relatedAuditTarget({ contentType: "comment" }, commentContext),
      { kind: KIND.PROPOSAL, id: "a" },
    );
    assert.equal(relatedAuditTarget({ contentType: "comment" }, { parent: null }), null);
    const commentView = relatedReceiptView({
      kind: KIND.COMMENT,
      comment: { authorRole: "evaluator", qualifying: true, recommendation: "do_not_recommend" },
    });
    assert.equal(commentView.showsAuditReceipt, false);
    assert.equal(commentView.recommendation, "Do not recommend");
  });

  it("[FIT-BAV-051] should open listing receipts only from expiry rows", () => {
    const expiry = governanceRow({
      type: "opportunity_expired",
      targetId: "problem",
      targetName: "Routing study",
    });
    assert.equal(expiry.showViewReceipt, true);
    assert.deepEqual(expiry.auditTarget, { kind: KIND.LISTING, id: "problem" });

    const listing = relatedReceiptView({
      kind: expiry.auditTarget.kind,
      record: { id: expiry.auditTarget.id, status: "expired", audit: { status: "confirmed" } },
    });
    assert.equal(listing.firebaseReference, "problems/problem");
    assert.equal(listing.verification, VERIFIED_STATES.VERIFIED);

    assert.equal(governanceRow({ type: "role_change", targetAddress: "0xabc" }).showViewReceipt, false);
    assert.equal(governanceRow({ type: "suspension_change", targetAddress: "0xabc" }).showViewReceipt, false);

    const admin = adminTrail({ isSignedIn: true, profile: { role: ROLE_ADMIN, suspended: false } });
    assert.equal(admin.action, "RENDER");
    const member = adminTrail({ isSignedIn: true, profile: { role: ROLE_USER, suspended: false } });
    assert.equal(member.action, "DENY_403");
  });
});
