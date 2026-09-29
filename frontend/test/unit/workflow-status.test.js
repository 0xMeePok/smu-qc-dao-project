import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECOMMENDATION_STATUSES,
  WORKFLOW_STATUS,
  WORKFLOW_STATUS_DETAILS,
  contributionWorkflowStatus,
  evaluationSummary,
  eventWorkflowStatus,
  noticeWorkflowStatus,
  opportunityWorkflowStatus,
  proposalWorkflowStatus,
  recommendationCounts,
  recommendationEntries,
} from "../../src/config/workflowStatus.js";

/** QCDAO-91 - one shared workflow status model. */

const S = WORKFLOW_STATUS;
const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const NOW = new Date("2026-09-29T00:00:00Z");
const PAST = "2026-01-01T00:00:00Z";
const FUTURE = "2099-01-01T00:00:00Z";

function sources(dir = SRC) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(jsx?|mjs)$/.test(name) ? [{ path: relative(SRC, path), text: readFileSync(path, "utf8") }] : [];
  });
}

// The mapping itself, and the badge that renders it.
const OWNERS = new Set(["config/workflowStatus.js", "components/StatusBadge.jsx"]);
// Moderation queue states are an admin-only family with their own filter, outside the workflow lifecycle.
const MODERATION_FAMILY = new Set(["components/ModerationQueue.jsx"]);
// Contract states have a separate lifecycle from the legacy selection workflow.
const ESCROW_FAMILY = new Set(["components/EscrowFundingPanel.jsx"]);

describe("[QCDAO-91] shared workflow status mapping", () => {
  it("gives every status a label, tone, icon, meaning and next step", () => {
    const badge = readFileSync(join(SRC, "components/StatusBadge.jsx"), "utf8");
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    for (const status of Object.values(S)) {
      const entry = WORKFLOW_STATUS_DETAILS[status];
      assert.ok(entry, `${status} has no mapping`);
      for (const key of ["label", "tone", "icon", "description", "next"]) assert.ok(entry[key], `${status}.${key}`);
      assert.match(badge, new RegExp(`["']?${entry.icon}["']?: \\[`), `${status} icon ${entry.icon}`);
      assert.match(css, new RegExp(`\\.workflow-badge\\.tone-${entry.tone} `), `${status} tone ${entry.tone}`);
    }
    const labels = Object.values(WORKFLOW_STATUS_DETAILS).map((entry) => entry.label);
    assert.equal(new Set(labels).size, labels.length, "labels are unique");
  });

  it("folds every stored opportunity state into the ticket vocabulary", () => {
    const fold = (problem) => opportunityWorkflowStatus({ expiresAt: FUTURE, ...problem }, NOW);
    assert.equal(fold({ status: "draft" }), S.DRAFT);
    for (const status of ["submitted", "open", "in_review"]) assert.equal(fold({ status }), S.SUBMITTED);
    assert.equal(fold({ status: "open", expiresAt: PAST }), S.EXPIRED);
    assert.equal(fold({ status: "expired" }), S.EXPIRED);
    assert.equal(fold({ status: "cancelled" }), S.DECLINED);
    assert.equal(fold({ status: "open", matching: { status: "awaiting_confirmation" } }), S.PENDING_APPROVAL);
    assert.equal(fold({ status: "open", expiresAt: PAST, matching: { status: "confirmed" } }), S.DECISION_RECORDED);
    for (const status of ["matched", "funded", "completed"]) assert.equal(fold({ status }), S.DECISION_RECORDED);
    assert.equal(fold({ status: "open", matching: { status: "invalidated" } }), S.INVALIDATED);
  });

  it("folds proposals by entity: the proposal is Selected while its opportunity is Pending approval", () => {
    const fold = (proposal, parent) => proposalWorkflowStatus(proposal, parent);
    assert.equal(fold({ status: "draft" }), S.DRAFT);
    assert.equal(fold({ status: "submitted", matching: { status: "funding" } }), S.SUBMITTED);
    assert.equal(fold({ status: "submitted", matching: { status: "awaiting_confirmation" } }), S.SELECTED);
    assert.equal(fold({ status: "submitted" }, { status: "awaiting_confirmation" }), S.SUBMITTED);
    assert.equal(fold({ status: "submitted", matching: { status: "confirmed" } }), S.ACCEPTED);
    assert.equal(fold({ status: "accepted" }), S.ACCEPTED);
    for (const status of ["withdrawn", "rejected"]) assert.equal(fold({ status }), S.DECLINED);
    assert.equal(fold({ status: "submitted", matching: { status: "declined" } }), S.DECLINED);
    assert.equal(fold({ status: "submitted", matching: { status: "voided" } }), S.INVALIDATED);
    assert.equal(fold({ status: "submitted" }, { status: "invalidated" }), S.INVALIDATED);
    assert.equal(fold({ status: "submitted", matching: { status: "cancelled" } }), S.REFUNDED);
    assert.equal(fold({ status: "submitted" }, { status: "confirmed" }), S.REFUNDED);
  });

  it("maps contributions, decision-record events and notices onto the same statuses", () => {
    assert.equal(contributionWorkflowStatus("pledged"), S.PENDING_APPROVAL);
    assert.equal(contributionWorkflowStatus("locked"), S.ACCEPTED);
    assert.equal(contributionWorkflowStatus("refunded"), S.REFUNDED);
    assert.equal(eventWorkflowStatus("owner_selected"), S.SELECTED);
    assert.equal(eventWorkflowStatus("match_confirmed"), S.DECISION_RECORDED);
    assert.equal(eventWorkflowStatus("creator_declined"), S.DECLINED);
    assert.equal(eventWorkflowStatus("confirmation_expired"), S.INVALIDATED);
    assert.equal(eventWorkflowStatus("opportunity_expired"), S.EXPIRED);
    assert.equal(eventWorkflowStatus("mock_evaluation_completed"), null);
    assert.equal(noticeWorkflowStatus({ workflowStatus: S.ACCEPTED }), S.ACCEPTED);
    assert.equal(noticeWorkflowStatus({ kind: "matching", eventType: "owner_selected" }), S.SELECTED);
    assert.equal(noticeWorkflowStatus({ kind: "proposal_received" }), S.SUBMITTED);
    assert.equal(noticeWorkflowStatus({ kind: "moderation" }), null);
  });

  it("does not infer an escrow's lifecycle from a legacy match on it or its sibling", () => {
    for (const status of ["awaiting_confirmation", "confirmed", "invalidated", "voided", "cancelled", "declined"]) {
      const proposal = { status: "submitted", fundingTerms: {}, matching: { status } };
      assert.equal(proposalWorkflowStatus(proposal, { status }), S.SUBMITTED);
    }
    assert.equal(proposalWorkflowStatus({ status: "draft", fundingTerms: {} }), S.DRAFT);
    assert.equal(proposalWorkflowStatus({ status: "withdrawn", fundingTerms: {} }), S.DECLINED);
  });

  it("counts one recommendation per evaluator, reading legacy single-holder proposals too", () => {
    const multi = { matching: { recommendations: {
      e1: { commentId: "c1", recommendation: "recommend" },
      e2: { commentId: "c2", recommendation: "recommend" },
      e3: { commentId: "c3", recommendation: "do_not_recommend" },
    } } };
    assert.deepEqual(recommendationCounts(multi), { recommend: 2, recommend_with_revisions: 0, do_not_recommend: 1 });
    const legacy = { matching: { recommendedBy: "e1", recommendationCommentId: "c1", recommendation: "recommend_with_revisions" } };
    assert.deepEqual(Object.keys(recommendationEntries(legacy)), ["e1"]);
    assert.equal(recommendationCounts(legacy).recommend_with_revisions, 1);
    assert.deepEqual(recommendationCounts(["recommend", "do_not_recommend"]), { recommend: 1, recommend_with_revisions: 0, do_not_recommend: 1 });
    assert.deepEqual(RECOMMENDATION_STATUSES, [S.RECOMMEND, S.RECOMMEND_WITH_REVISIONS, S.DO_NOT_RECOMMEND]);
  });

  it("combines several evaluations into one badge: one icon per outcome given, a lone outcome twice", () => {
    const summary = (recommend = 0, revisions = 0, against = 0) =>
      evaluationSummary({ recommend, recommend_with_revisions: revisions, do_not_recommend: against });
    assert.equal(summary().status, S.AWAITING_EVALUATOR_FEEDBACK);
    assert.deepEqual(summary(0, 0, 1), { total: 1, status: S.DO_NOT_RECOMMEND });
    assert.deepEqual(summary(2), { total: 2, status: S.EVALUATIONS, icons: ["thumbs-up", "thumbs-up"], tone: "success",
      text: "2 evaluations", breakdown: "2 recommended" });
    assert.deepEqual(summary(0, 0, 3).icons, ["thumbs-down", "thumbs-down"]);
    assert.equal(summary(0, 0, 3).tone, "danger");
    assert.deepEqual(summary(3, 0, 1).icons, ["thumbs-up", "thumbs-down"]);
    assert.equal(summary(3, 0, 1).tone, "warning");
    assert.deepEqual(summary(0, 2).icons, ["revise", "revise"]);
    assert.deepEqual(summary(1, 2).icons, ["thumbs-up", "revise"]);
    const all = summary(2, 1, 1);
    assert.deepEqual(all.icons, ["thumbs-up", "revise", "thumbs-down"]);
    assert.equal(all.text, "4 evaluations");
    assert.equal(all.breakdown, "2 recommended · 1 recommended with revisions · 1 did not recommend");
  });
});

describe("[QCDAO-91] automated check: no status string rendered outside the shared mapping", () => {
  const labels = Object.values(WORKFLOW_STATUS_DETAILS).map((entry) => entry.label)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const files = sources().filter((file) => !OWNERS.has(file.path));
  const offending = (pattern, skip = new Set()) => files
    .filter((file) => !skip.has(file.path))
    .flatMap((file) => file.text.split("\n").map((line, index) => ({ line, at: `${file.path}:${index + 1}` })))
    .filter(({ line }) => pattern.test(line))
    .map(({ at, line }) => `${at}  ${line.trim()}`);

  it("never hard-codes a status label as JSX text (date headings such as <dt>Submitted</dt> aside)", () => {
    const pattern = new RegExp(`<(?!dt\\b|th\\b)[a-zA-Z][\\w.-]*(\\s[^<>]*)?>\\s*(${labels.join("|")})\\s*</`);
    assert.deepEqual(offending(pattern), []);
  });

  it("never hard-codes a status label as a string literal", () => {
    const pattern = new RegExp(`["'\`](${labels.join("|")})["'\`]`);
    assert.deepEqual(offending(pattern, ESCROW_FAMILY), []);
  });

  it("never humanises or prints a stored status field directly", () => {
    const humanised = /\.(status|matchingStatus|type)\??\.(replace|replaceAll)\(/;
    const printed = /(?<![=\w])\{\s*[\w.?]+\.(status|matchingStatus)\s*\}|\$\{\s*[\w.?]+\.(status|matchingStatus)\s*\}/;
    assert.deepEqual(offending(humanised), []);
    assert.deepEqual(offending(printed, MODERATION_FAMILY), []);
  });

  it("retires the ad-hoc status pills in favour of StatusBadge", () => {
    assert.deepEqual(offending(/status-dot|funding-pill|submission-status-badge|MATCHING_LABELS|STATUS_LABELS/), []);
  });
});
