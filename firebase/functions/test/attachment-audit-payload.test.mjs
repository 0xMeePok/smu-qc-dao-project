import assert from "node:assert/strict";
import { test } from "node:test";
import { postingAuditPayload, fundingOpportunityAuditPayload } from "../opportunityAuditPayload.js";

const file = (digest) => ({ id: "abcdefgh", name: "evidence.pdf", size: 1024,
  contentType: "application/pdf", sha256: digest });
const a = `0x${"a".repeat(64)}`;
const b = `0x${"b".repeat(64)}`;

test("new opportunity payloads bind attachment digests without loading PDF bytes", () => {
  for (const payload of [postingAuditPayload, fundingOpportunityAuditPayload]) {
    const first = payload({ attachments: [file(a)] });
    const changed = payload({ attachments: [file(b)] });
    assert.equal(first.attachments[0].sha256, a);
    assert.notDeepEqual(first.attachments, changed.attachments);
  }
});

test("historical anchored opportunity payloads keep their original attachment projection", () => {
  for (const payload of [postingAuditPayload, fundingOpportunityAuditPayload]) {
    const old = payload({ audit: { transactionHash: `0x${"1".repeat(64)}` }, attachments: [file(a)] });
    assert.equal("sha256" in old.attachments[0], false);
    const newReceipt = payload({ audit: { digestVersion: 1, transactionHash: `0x${"1".repeat(64)}` },
      attachments: [file(a)] });
    assert.equal(newReceipt.attachments[0].sha256, a);
  }
});
