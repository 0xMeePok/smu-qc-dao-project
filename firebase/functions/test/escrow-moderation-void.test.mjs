import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { memoryDb } from "./memoryDb.mjs";
import { enqueueModerationVoidJobs, moderationVoidReasonHash, voidDecision } from "../escrowModerationVoid.js";
import { enqueueIndependentFundingCancellation } from "../independentFundingModeration.js";
import { prepareRemovedProposalClaim } from "../escrowFunding.js";
import { moderateContent } from "../moderation.js";
import { prepareModerationMatching } from "../matching.js";

const now = Timestamp.fromMillis(1_800_000_000_000);

test("[BUT-ACM-74] void decisions skip finished escrows and wait when the signer is not an admin", () => {
  assert.equal(voidDecision("Open", true).outcome, "void");
  assert.equal(voidDecision("Locked", true).outcome, "void");
  assert.equal(voidDecision("Active", true).outcome, "void");
  assert.equal(voidDecision("Released", true).skipReason, "Released");
  assert.equal(voidDecision("Refunded", true).outcome, "skipped");
  assert.equal(voidDecision("Voided", true).outcome, "skipped");
  assert.equal(voidDecision("Open", false).outcome, "awaiting-admin");
  assert.notEqual(moderationVoidReasonHash("proposal_a_1", "misleading"), `0x${"0".repeat(64)}`);
});

test("[BUT-ACM-75] remove enqueues a void for the affected escrow only", async () => {
  const db = memoryDb({
    "users/admin": { role: 1, fullName: "Moderator" },
    "users/owner": { role: 0, fullName: "Owner", organisation: "Lab" },
    "users/alice": { role: 0, fullName: "Alice" },
    "problems/problem": { ownerId: "owner", title: "Study", summary: "Routes", status: "submitted", currency: "USDC", createdAt: now },
    "proposals/a": { researcherId: "alice", postingOwnerId: "owner", problemId: "problem", title: "A", summary: "One", status: "submitted", fundingTerms: { target: "1" }, createdAt: now },
    "proposals/b": { researcherId: "alice", postingOwnerId: "owner", problemId: "problem", title: "B", summary: "Two", status: "submitted", fundingTerms: { target: "1" }, createdAt: now },
    "proposals/indie": { researcherId: "alice", proposalKind: "independent", title: "Indie", summary: "Solo", status: "submitted", fundingTerms: { target: "1" }, createdAt: now },
    "moderationQueue/proposal_a": { status: "pending", contentType: "proposal", contentId: "a" },
    "moderationQueue/proposal_indie": { status: "pending", contentType: "proposal", contentId: "indie" },
    "moderationQueue/problem_problem": { status: "pending", contentType: "problem", contentId: "problem" },
  });
  const removed = await moderateContent({
    db, uid: "admin", queueId: "proposal_a", action: "remove", reason: "misleading", now, prepareMatching: prepareModerationMatching,
  });
  assert.equal((await enqueueModerationVoidJobs({
    db, contentType: "proposal", contentId: "a", eventId: removed.eventId, reason: "misleading", now,
  })).enqueued, 1);
  const jobs = [...db.records.keys()].filter((path) => path.startsWith("escrowModerationVoidJobs/"));
  assert.equal(jobs.length, 1);
  assert.equal(db.records.get(jobs[0]).proposalId, "a");
  const indie = await moderateContent({
    db, uid: "admin", queueId: "proposal_indie", action: "remove", reason: "misleading", now, prepareMatching: prepareModerationMatching,
  });
  assert.equal((await enqueueModerationVoidJobs({
    db, contentType: "proposal", contentId: "indie", eventId: indie.eventId, reason: "misleading", now,
  })).enqueued, 0);
  assert.equal((await enqueueIndependentFundingCancellation({
    db, contentType: "proposal", contentId: "indie", eventId: indie.eventId, reason: "misleading", now,
  })).enqueued, 1);
  const problem = await moderateContent({
    db, uid: "admin", queueId: "problem_problem", action: "remove", reason: "abusive", now, prepareMatching: prepareModerationMatching,
  });
  assert.equal((await enqueueModerationVoidJobs({
    db, contentType: "problem", contentId: "problem", eventId: problem.eventId, reason: "abusive", now,
  })).enqueued, 2);
  const proposalIds = [...db.records.entries()].filter(([path]) => path.startsWith("escrowModerationVoidJobs/")).map(([, row]) => row.proposalId).sort();
  assert.deepEqual(proposalIds, ["a", "a", "b"]);
  const independentJobs = [...db.records.entries()].filter(([path]) => path.startsWith("independentFundingCancellationJobs/"));
  assert.equal(independentJobs.length, 1);
  assert.equal(independentJobs[0][1].proposalId, "indie");
});

test("[BUT-ACM-76] a funded proposal can be claimed after its problem is removed", async () => {
  const db = memoryDb({
    "users/funder": { role: 0 },
    "problems/problem": { ownerId: "owner", title: "Study", summary: "Secret", status: "moderated_removed", moderationStatus: "removed" },
    "proposals/funded": { researcherId: "alice", postingOwnerId: "owner", problemId: "problem", title: "Funded", status: "submitted", fundingTerms: { target: "1" } },
    "proposals/plain": { researcherId: "alice", postingOwnerId: "owner", problemId: "problem", title: "Plain", status: "submitted" },
    "problems/live": { ownerId: "owner", title: "Live", status: "submitted" },
    "proposals/open": { researcherId: "alice", postingOwnerId: "owner", problemId: "live", title: "Open", status: "submitted", fundingTerms: { target: "1" } },
  });
  let reads = 0;
  const client = { getBlockNumber: async () => { reads += 1; throw new Error("offline"); } };
  await assert.rejects(
    () => prepareRemovedProposalClaim({ db, client, config: {}, uid: "funder", proposalId: "funded" }),
    { code: "unavailable" },
  );
  assert.equal(reads, 1);
  const plain = await prepareRemovedProposalClaim({ db, client, config: {}, uid: "funder", proposalId: "plain" });
  assert.equal(plain.claimable, false);
  assert.equal(reads, 1);
  await assert.rejects(
    () => prepareRemovedProposalClaim({ db, client, config: {}, uid: "funder", proposalId: "open" }),
    { code: "failed-precondition" },
  );
  assert.equal(reads, 1);
});
