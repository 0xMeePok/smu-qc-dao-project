import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { opportunityWorkflowStatus, WORKFLOW_STATUS } from "../workflowStatus.js";

const now = new Date("2026-10-02T00:00:00Z");
const posting = { status: "submitted", opportunityType: "business-problem", expiresAt: new Date("2027-01-01T00:00:00Z") };

describe("confirmed main posting status", () => {
  it("shows the recorded main decision after upfront payment despite a stale open status or deadline", () => {
    const confirmed = { ...posting, hasAcceptedSolution: true, acceptedProposalId: "winner",
      escrowSelection: { proposalId: "winner" } };
    assert.equal(opportunityWorkflowStatus(confirmed, now), WORKFLOW_STATUS.DECISION_RECORDED);
    assert.equal(opportunityWorkflowStatus({ ...confirmed, opportunityType: undefined, status: "open" }, now), WORKFLOW_STATUS.DECISION_RECORDED);
    assert.equal(opportunityWorkflowStatus({ ...confirmed, expiresAt: new Date("2026-01-01T00:00:00Z") }, now), WORKFLOW_STATUS.DECISION_RECORDED);
  });
  it("requires both trusted acceptance fields rather than treating a selection request as a confirmed award", () => {
    for (const fields of [{ escrowSelection: { proposalId: "winner" } }, { hasAcceptedSolution: true },
      { acceptedProposalId: "winner" }, { hasAcceptedSolution: true, acceptedProposalId: " " }]) {
      assert.equal(opportunityWorkflowStatus({ ...posting, ...fields }, now), WORKFLOW_STATUS.SUBMITTED);
    }
    assert.equal(opportunityWorkflowStatus({ ...posting, matching: { status: "awaiting_confirmation" } }, now), WORKFLOW_STATUS.PENDING_APPROVAL);
  });
  it("keeps a multi-award grant open and retains its actual expiry despite legacy single-winner fields", () => {
    const grant = { ...posting, opportunityType: "open-funding", hasAcceptedSolution: true, acceptedProposalId: "winner" };
    assert.equal(opportunityWorkflowStatus(grant, now), WORKFLOW_STATUS.SUBMITTED);
    assert.equal(opportunityWorkflowStatus({ ...grant, expiresAt: new Date("2026-01-01T00:00:00Z") }, now), WORKFLOW_STATUS.EXPIRED);
  });
  it("preserves private draft and legacy recorded-match behavior", () => {
    assert.equal(opportunityWorkflowStatus({ ...posting, status: "draft", hasAcceptedSolution: true, acceptedProposalId: "winner" }, now), WORKFLOW_STATUS.DRAFT);
    assert.equal(opportunityWorkflowStatus({ ...posting, matching: { status: "confirmed" } }, now), WORKFLOW_STATUS.DECISION_RECORDED);
  });
});
