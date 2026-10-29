import assert from "node:assert/strict";
import { test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { isPublishableIndependentProposal } from "../publicationValidation.js";
const uid = `0x${"6".repeat(40)}`;
const independent = {
  researcherId: uid, proposalKind: "independent", title: "Routing evaluation", summary: "Evaluate a hybrid routing baseline.",
  methodology: "Compare reproducible baselines.", addressedProblems: "Urban delivery scheduling.", team: "Author-entered team experience.",
  category: "hybrid", maturity: "concept", amount: 100, currency: "USDC", status: "submitted",
  expiresAt: Timestamp.fromMillis(Date.now() + 90 * 86400000), attachments: [],
};
test("independent publication accepts only boolean AI attribution and rejects chat payloads", () => {
  assert.equal(isPublishableIndependentProposal(independent, { uid }), true);
  assert.equal(isPublishableIndependentProposal({ ...independent, aiAssisted: true }, { uid }), true);
  for (const aiAssisted of ["true", 1, null, []]) assert.equal(isPublishableIndependentProposal({ ...independent, aiAssisted }, { uid }), false);
  assert.equal(isPublishableIndependentProposal({ ...independent, aiAssisted: true, messages: [] }, { uid }), false);
});
