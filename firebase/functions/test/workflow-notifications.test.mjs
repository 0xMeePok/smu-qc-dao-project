import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { memoryDb } from "./memoryDb.mjs";
import { createComment, deleteComment } from "../comments.js";
import {
  listModerationNotifications,
  markAllModerationNotificationsRead,
  notificationNavigationTarget,
  notifyProposalReceived,
} from "../moderation.js";
import { remindNearingApprovalWindows } from "../matchingNotifications.js";

/** QCDAO-68 - receive in-platform notifications for workflow events. */

const now = Timestamp.fromMillis(1_800_000_000_000);
const later = (ms) => Timestamp.fromMillis(now.toMillis() + ms);
const HOUR = 60 * 60 * 1000;
const WITHIN_NEARING_WINDOW = 6 * HOUR;

function fixture(extra = {}) {
  return memoryDb({
    "users/owner": { role: 0, fullName: "Problem owner" },
    "users/alice": { role: 0, fullName: "Alice" },
    "users/evaluator": { role: 2, fullName: "Assigned evaluator" },
    "problems/problem": {
      ownerId: "owner",
      title: "Routing study",
      summary: "Improve routes",
      status: "submitted",
      createdAt: now,
    },
    "proposals/a": {
      researcherId: "alice",
      postingOwnerId: "owner",
      problemId: "problem",
      title: "Proposal A",
      summary: "A routing approach",
      status: "submitted",
      createdAt: now,
    },
    ...extra,
  });
}

function notices(db, uid) {
  return [...db.records.entries()]
    .filter(([path, row]) => path.startsWith("moderationNotifications/") && (!uid || row.recipientId === uid))
    .map(([path, row]) => ({ path, ...row }));
}

describe("[QCDAO-68] receive in-platform notifications for workflow events", () => {
  it("[BUT-SPE-27] Header centre shows unread notification badge", async () => {
    const db = fixture();
    await notifyProposalReceived({
      db, proposalId: "a", now, before: { status: "draft" }, after: db.records.get("proposals/a"),
    });
    const owner = await listModerationNotifications({ db, uid: "owner" });
    const researcher = await listModerationNotifications({ db, uid: "alice" });
    assert.equal(owner.items.length, 1);
    assert.equal(owner.items[0].read, false);
    assert.equal(owner.items[0].readAt, null);
    assert.equal(owner.items[0].recipientId, "owner");
    assert.equal(researcher.items.length, 0);
  });

  it("[BUT-SPE-28] Mark all unread notices as read", async () => {
    const db = fixture({
      "moderationNotifications/n1": { recipientId: "owner", createdAt: now, readAt: null, message: "First" },
      "moderationNotifications/n2": { recipientId: "owner", createdAt: later(1000), readAt: null, message: "Second" },
      "moderationNotifications/n3": { recipientId: "owner", createdAt: later(2000), readAt: now, message: "Already read" },
      "moderationNotifications/n4": { recipientId: "alice", createdAt: later(3000), readAt: null, message: "Other member" },
    });
    const result = await markAllModerationNotificationsRead({ db, uid: "owner", now: later(4000) });
    assert.equal(result.ok, true);
    assert.equal(result.updated, 2);
    assert.equal(db.records.get("moderationNotifications/n1").readAt.toMillis(), later(4000).toMillis());
    assert.equal(db.records.get("moderationNotifications/n2").readAt.toMillis(), later(4000).toMillis());
    assert.equal(db.records.get("moderationNotifications/n3").readAt.toMillis(), now.toMillis());
    assert.equal(db.records.get("moderationNotifications/n4").readAt, null);
    const listed = await listModerationNotifications({ db, uid: "owner" });
    assert.ok(listed.items.every((item) => item.read));
    assert.equal((await listModerationNotifications({ db, uid: "alice" })).items[0].read, false);
  });

  it("[BUT-SPE-29] Notices deep-link to proposal or posting", async () => {
    assert.equal(notificationNavigationTarget({ contentType: "comment", proposalId: "a", problemId: "problem" }), "proposal/a");
    assert.equal(notificationNavigationTarget({ contentType: "proposal", contentId: "a" }), "proposal/a");
    assert.equal(notificationNavigationTarget({ contentType: "problem", contentId: "problem" }), "posting/problem");
    const db = fixture();
    db.records.get("problems/problem").matching = {
      status: "awaiting_confirmation",
      proposalId: "a",
      selectionId: "sel1",
      deadlineAt: later(WITHIN_NEARING_WINDOW),
    };
    await notifyProposalReceived({
      db, proposalId: "a", now, before: { status: "draft" }, after: db.records.get("proposals/a"),
    });
    await remindNearingApprovalWindows({ db, now });
    const owner = await listModerationNotifications({ db, uid: "owner" });
    const received = owner.items.find((item) => item.kind === "proposal_received");
    const reminder = owner.items.find((item) => item.kind === "approval_nearing_expiry");
    assert.equal(received.navigationTarget, "proposal/a");
    assert.equal(received.link, "#/proposal/a");
    assert.equal(reminder.navigationTarget, "posting/problem");
    assert.equal(reminder.link, "#/posting/problem");
  });

  it("[BUT-SPE-30] Owner notified when a proposal is submitted", async () => {
    const db = fixture();
    const after = db.records.get("proposals/a");
    const written = await notifyProposalReceived({
      db, proposalId: "a", now, before: { status: "draft" }, after,
    });
    assert.equal(written.written, true);
    const notice = notices(db, "owner")[0];
    assert.equal(notice.kind, "proposal_received");
    assert.equal(notice.recipientId, "owner");
    assert.equal(notice.contentType, "proposal");
    assert.equal(notice.contentId, "a");
    assert.match(notice.message, /Proposal A/);
    assert.equal((await notifyProposalReceived({
      db, proposalId: "a", now, before: { status: "submitted" }, after,
    })).written, false);
    assert.equal(notices(db, "owner").length, 1);
    assert.equal(notices(db, "alice").length, 0);
    assert.equal((await notifyProposalReceived({
      db, proposalId: "a", now, before: { status: "draft" }, after: { ...after, postingOwnerId: "" },
    })).written, false);
  });

  it("[BUT-SPE-31] Owner notified of a qualifying evaluator recommendation", async () => {
    const db = fixture();
    delete db.records.get("proposals/a").postingOwnerId;
    const created = await createComment({
      db, uid: "evaluator", proposalId: "a", now,
      body: "The claimed latency needs a cited benchmark.",
      recommendation: "recommend",
    });
    assert.equal(created.qualifying, true);
    const ownerKinds = notices(db, "owner").map((row) => row.kind);
    assert.ok(ownerKinds.includes("qualifying_recommendation"));
    assert.ok(ownerKinds.includes("evaluation_gate"));
    assert.ok(notices(db, "alice").some((row) => row.kind === "qualifying_recommendation"));
    assert.equal(notices(db, "evaluator").length, 0);
    const notice = notices(db, "owner").find((row) => row.kind === "qualifying_recommendation");
    assert.equal(notice.recipientId, "owner");
    assert.equal(notice.navigationTarget, "proposal/a");
    assert.match(notice.message, /Recommend/);
  });

  it("[BUT-SPE-32] Owner notified when an evaluator deletes the recommendation", async () => {
    const db = fixture();
    db.records.get("proposals/a").matching = {
      evaluationComplete: true,
      evaluationMockComplete: true,
      evaluationCompletedBy: "admin",
    };
    const created = await createComment({
      db, uid: "evaluator", proposalId: "a", now,
      body: "The claimed latency needs a cited benchmark.",
      recommendation: "recommend",
    });
    await deleteComment({ db, uid: "evaluator", commentId: created.id, now: later(1000) });
    const ownerKinds = notices(db, "owner").map((row) => row.kind);
    assert.ok(ownerKinds.includes("qualifying_recommendation_removed"));
    assert.equal(ownerKinds.includes("evaluation_gate"), false);
    assert.ok(notices(db, "alice").some((row) => row.kind === "qualifying_recommendation_removed"));
    assert.equal(notices(db, "evaluator").some((row) => row.kind === "qualifying_recommendation_removed"), false);
    const notice = notices(db, "owner").find((row) => row.kind === "qualifying_recommendation_removed");
    assert.equal(notice.recipientId, "owner");
    assert.match(notice.message, /removed a qualifying recommendation/);
  });

  it("[BUT-SPE-33] Owner reminded once when approval is nearing expiry", async () => {
    const db = fixture();
    db.records.get("problems/problem").matching = {
      status: "awaiting_confirmation",
      proposalId: "a",
      selectionId: "sel1",
      deadlineAt: later(WITHIN_NEARING_WINDOW),
    };
    const first = await remindNearingApprovalWindows({ db, now });
    assert.equal(first.notified, 2);
    const ownerNotice = notices(db, "owner").find((row) => row.kind === "approval_nearing_expiry");
    assert.ok(ownerNotice);
    assert.equal(ownerNotice.recipientId, "owner");
    assert.equal(ownerNotice.contentType, "problem");
    assert.equal(ownerNotice.navigationTarget, "posting/problem");
    assert.ok(notices(db, "alice").some((row) => row.kind === "approval_nearing_expiry"));
    assert.equal(notices(db, "evaluator").length, 0);
    assert.equal((await remindNearingApprovalWindows({ db, now: later(HOUR) })).notified, 0);
    assert.equal(notices(db).filter((row) => row.kind === "approval_nearing_expiry").length, 2);
    db.records.get("problems/problem").matching.status = "open";
    db.records.get("problems/problem").matching.deadlineAt = later(2 * HOUR);
    assert.equal((await remindNearingApprovalWindows({ db, now })).notified, 0);
  });
});
