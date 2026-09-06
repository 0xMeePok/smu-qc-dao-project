import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS, PROPOSAL_CATEGORIES } from "../../src/config/proposal.js";
import { proposalBlockReason, validateProposal, messageForProposalError } from "../../src/lib/proposalValidation.js";
import { buildProposalDocument } from "../../src/lib/proposals.js";
import { attachmentPath } from "../../src/lib/attachments.js";

const posting = { id: "problem-1", ownerId: "0xowner", status: "submitted", currency: "USDC", expiresAt: new Date("2099-01-01") };
const form = { ...Object.fromEntries(PROPOSAL_FIELDS.map(([key]) => [key, ` ${key} content `])), amount: "1500", category: "quantum-inspired" };
describe("QCDAO-59/60 proposals", () => {
  it("hides raw database diagnostics and preserves actionable business errors", () => {
    assert.match(messageForProposalError({ code: "permission-denied", message: "evaluation error at L860" }), /not available to your account/);
    assert.doesNotMatch(messageForProposalError({ code: "permission-denied", message: "evaluation error at L860" }), /L860/);
    assert.match(messageForProposalError({ code: "unavailable" }), /connection/);
    assert.equal(messageForProposalError(new Error("The submission deadline has passed.")), "The submission deadline has passed.");
  });
  it("supports every quantum and quantum-adjacent approach", () => {
    for (const { value } of PROPOSAL_CATEGORIES) assert.deepEqual(validateProposal({ ...form, category: value }, posting), {});
  });
  it("requires problem framing only for open funding", () => {
    assert.deepEqual(validateProposal(form, posting), {});
    const funding = { ...posting, opportunityType: "open-funding" };
    assert.deepEqual(Object.keys(validateProposal(form, funding)), PROBLEM_FRAMING_FIELDS.map(([key]) => key));
    assert.deepEqual(validateProposal({ ...form, ...Object.fromEntries(PROBLEM_FRAMING_FIELDS.map(([key]) => [key, "Problem framing"])) }, funding), {});
  });
  it("rejects blank fields, unknown categories, invalid funding and oversized input", () => {
    for (const amount of ["", "0", "-1", "Infinity", "1000000001", "abc"]) assert.ok(validateProposal({ ...form, amount }, posting).amount);
    assert.ok(validateProposal({ ...form, title: " ", category: "unknown" }, posting).title);
    assert.ok(validateProposal({ ...form, methodology: "x".repeat(4001) }, posting).methodology);
  });
  it("blocks every closed status, moderation and accepted solutions", () => {
    for (const status of ["expired", "withdrawn", "moderated", "matched", "funded", "draft", "completed", "cancelled"]) assert.ok(proposalBlockReason({ ...posting, status }));
    for (const patch of [{ acceptedProposalId: "p" }, { acceptedSolutionId: "s" }, { hasAcceptedSolution: true }, { moderated: true }, { moderationStatus: "hidden" }]) assert.ok(proposalBlockReason({ ...posting, ...patch }));
    assert.equal(proposalBlockReason(posting), "");
    assert.ok(proposalBlockReason({ ...posting, expiresAt: new Date(100) }, new Date(100)));
  });
  it("stores the author, parent and sponsor linkage with submitted status", () => {
    const record = buildProposalDocument({ researcherId: "0xABC", posting, form });
    assert.equal(record.researcherId, "0xabc");
    assert.equal(record.problemId, posting.id);
    assert.equal(record.postingOwnerId, posting.ownerId);
    assert.equal(record.status, "submitted");
    assert.equal(record.amount, 1500);
    assert.equal(record.currency, "USDC");
    assert.equal(record.title, "title content");
    assert.ok(record.createdAt);
  });
  it("keeps proposal attachments in a separate private namespace", () => {
    assert.equal(attachmentPath({ ownerId: "0xABC", problemId: "proposal1", attachmentId: "file1234", scope: "proposals" }), "proposals/0xabc/proposal1/file1234.pdf");
  });
});
