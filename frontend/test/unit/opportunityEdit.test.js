import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canEditOpportunity,
  materialFieldsLocked,
  MATERIAL_POSTING_FIELDS,
  NON_MATERIAL_OPPORTUNITY_FIELDS,
} from "../../src/lib/opportunityEdit.js";

const OWNER = `0x${"a".repeat(40)}`;

describe("opportunity edit policy", () => {
  it("lets the owner correct a live posting before any proposal arrives", () => {
    const posting = { ownerId: OWNER, status: "submitted", proposalCount: 0 };
    assert.equal(canEditOpportunity(posting, OWNER), true);
    assert.equal(materialFieldsLocked(posting), false);
    assert.ok(MATERIAL_POSTING_FIELDS.includes("title"));
    assert.ok(MATERIAL_POSTING_FIELDS.includes("amount"));
    assert.deepEqual(NON_MATERIAL_OPPORTUNITY_FIELDS, ["attachments"]);
  });

  it("locks material fields after the first proposal, and refuses edits once withdrawn", () => {
    assert.equal(materialFieldsLocked({ proposalCount: 1 }), true);
    assert.equal(canEditOpportunity({ ownerId: OWNER, status: "open", proposalCount: 2 }, OWNER), true);
    assert.equal(canEditOpportunity({ ownerId: OWNER, status: "cancelled", proposalCount: 0 }, OWNER), false);
    assert.equal(canEditOpportunity({ ownerId: OWNER, status: "submitted" }, `0x${"b".repeat(40)}`), false);
  });
});
