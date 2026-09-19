import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** View an audit receipt for a verified event — timestamp fallback and reachability. */

function source(relativeFromTest) {
  return readFileSync(new URL(relativeFromTest, import.meta.url), "utf8");
}

describe("Unit Tests: Audit receipt timestamp and related-event reachability", () => {
  it("[FUT-BAV-146] should prefer chain time then record timestamp", () => {
    const receipt = source("../../src/components/AuditReceipt.jsx");
    assert.match(receipt, /function receiptInstant\(chainTimestamp, recordTimestamp\) \{[\s\S]*?return chainInstant\(chainTimestamp\) \?\? toDate\(recordTimestamp\);/);
    assert.match(receipt, /recordTimestamp,/);
    assert.match(receipt, /const timestamp = receiptInstant\(chainTimestamp, recordTimestamp\);/);
    assert.match(receipt, /<dt>Timestamp<\/dt>/);
    assert.doesNotMatch(receipt, /<dt>On-chain timestamp<\/dt>/);

    const callers = [
      source("../../src/pages/ProposalDetailPage.jsx"),
      source("../../src/pages/PostingDetailPage.jsx"),
      source("../../src/pages/CreatePostingPage.jsx"),
      source("../../src/pages/CreateFundingOpportunityPage.jsx"),
      source("../../src/components/SubmissionLogs.jsx"),
      source("../../src/components/ProposalAuditQueue.jsx"),
    ];
    for (const file of callers) {
      assert.match(file, /recordTimestamp=\{[^}]*updatedAt \?\? [^}]*createdAt\}/);
    }
  });

  it("[FUT-BAV-147] should deny on-chain receipts for evaluator comments", () => {
    const pane = source("../../src/components/RelatedAuditReceiptPane.jsx");
    assert.match(pane, /COMMENT: "comment"/);
    assert.match(pane, /if \(!record \|\| kind === RELATED_AUDIT_KIND.COMMENT\) return null;/);
    assert.match(pane, /kind === RELATED_AUDIT_KIND.COMMENT && \(/);
    assert.match(pane, /Evaluator recommendation comments are recorded off-chain/);
    assert.match(pane, /do not[\s\S]*have an on-chain audit receipt/);
    assert.match(pane, /record && kind !== RELATED_AUDIT_KIND.COMMENT && \(/);
    assert.match(pane, /<RelatedAuditReceipt kind=\{kind\} record=\{record\} \/>/);

    const comments = source("../../src/components/ReportableComments.jsx");
    assert.doesNotMatch(comments, /VerifiedBadge/);
    assert.doesNotMatch(comments, /AuditReceipt/);
    assert.match(comments, /role-chip-evaluator|Evaluator/);
    assert.match(comments, /recommendationLabel/);
  });

  it("[FUT-BAV-148] should wire proposal and listing receipt fields", () => {
    const pane = source("../../src/components/RelatedAuditReceiptPane.jsx");
    assert.match(pane, /firebaseReference=\{`proposals\/\$\{record\.id\}`\}/);
    assert.match(pane, /eventLabel="Proposal submitted"/);
    assert.match(pane, /actorRole="Researcher \/ solution developer"/);
    assert.match(pane, /onVerify=\{\(\) => readProposalAudit\(record\)\}/);
    assert.match(pane, /firebaseReference=\{`problems\/\$\{prepared\.id\}`\}/);
    assert.match(pane, /Open funding opportunity submitted/);
    assert.match(pane, /Problem statement submitted/);
    assert.match(pane, /actorRole=\{isOpenFunding \? "Funder" : "Problem owner"\}/);
    assert.match(pane, /readFundingOpportunityAudit\(prepared\)/);
    assert.match(pane, /readPostingAudit\(prepared\)/);
  });

  it("[FUT-BAV-149] should open the proposal receipt from matching escrow", () => {
    const matching = source("../../src/components/MatchingPanel.jsx");
    assert.match(matching, /findProposal/);
    assert.match(matching, /kind: RELATED_AUDIT_KIND.PROPOSAL/);
    assert.match(matching, /openProposalAudit\(selectedProposalId\)/);
    assert.match(matching, /\["owner_selected", "owner_confirmed", "creator_confirmed", "match_confirmed"\]/);
    assert.match(matching, /settlementAudit && confirmed/);
    assert.match(matching, /View funding settlement record/);
    assert.match(matching, /View audit receipt/);
    assert.match(matching, /Recorded off-chain/);

    const portfolio = source("../../src/components/MockFundingPortfolio.jsx");
    assert.match(portfolio, /findProposal\(id\)/);
    assert.match(portfolio, /kind: RELATED_AUDIT_KIND.PROPOSAL/);
    assert.match(portfolio, /openProposalAudit\(item.proposalId\)/);
    assert.match(portfolio, /View audit receipt/);
    assert.match(portfolio, /View proposal/);
  });

  it("[FUT-BAV-150] should open related receipts from moderation and expiry", () => {
    const moderation = source("../../src/components/ModerationQueue.jsx");
    assert.match(moderation, /function relatedAuditTarget/);
    assert.match(moderation, /selected.contentType === "comment"/);
    assert.match(moderation, /parent\?\.contentType === "proposal"/);
    assert.match(moderation, /RELATED_AUDIT_KIND.PROPOSAL/);
    assert.match(moderation, /parent\?\.contentType === "problem"/);
    assert.match(moderation, /RELATED_AUDIT_KIND.LISTING/);
    assert.match(moderation, /selected.contentType === "proposal"/);
    assert.match(moderation, /selected.contentType === "problem"/);
    assert.doesNotMatch(moderation, /RELATED_AUDIT_KIND.COMMENT/);
    assert.match(moderation, /View parent audit receipt/);
    assert.match(moderation, /Comments are recorded off-chain and do not have an on-chain audit receipt/);
    assert.match(moderation, /findProposal\(auditTarget.id\)/);
    assert.match(moderation, /findPosting\(auditTarget.id\)/);

    const governance = source("../../src/components/RoleViews.jsx");
    const expiryBlock = governance.split("{isExpiry ? (")[1]?.split(") : (")[0] ?? "";
    assert.match(expiryBlock, /View receipt/);
    assert.match(expiryBlock, /openListingAudit\(item.targetId \|\| item.target\)/);
    assert.match(governance, /kind: RELATED_AUDIT_KIND.LISTING/);
    assert.match(governance, /findPosting\(id\)/);
    const roleOrSuspend = governance.split(") : (")[1]?.split("</td>")[0] ?? "";
    assert.doesNotMatch(roleOrSuspend, /View receipt/);
    assert.doesNotMatch(roleOrSuspend, /openListingAudit/);
  });
});
