import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { memoryDb } from "../../../firebase/functions/test/memoryDb.mjs";
import { createComment, deleteComment } from "../../../firebase/functions/comments.js";
import {
  listModerationNotifications,
  markAllModerationNotificationsRead,
  notificationNavigationTarget,
  notifyProposalReceived,
} from "../../../firebase/functions/moderation.js";
import { remindNearingApprovalWindows } from "../../../firebase/functions/matchingNotifications.js";

/** QCDAO-68 - receive in-platform notifications for workflow events. */

const require = createRequire(new URL("../../../firebase/functions/package.json", import.meta.url));
const { Timestamp } = require("firebase-admin/firestore");
const now = Timestamp.fromMillis(1_800_000_000_000);
const later = (ms) => Timestamp.fromMillis(now.toMillis() + ms);
const HOUR = 60 * 60 * 1000;

function source(relativeFromTest) {
  return readFileSync(new URL(relativeFromTest, import.meta.url), "utf8");
}

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
  it("[FUT-SPE-151] Header centre shows unread notification badge", () => {
    const app = source("../../src/App.jsx");
    const ui = source("../../src/components/ModerationNotifications.jsx");
    assert.match(app, /<NotificationCentre userId=\{address\} \/>/);
    assert.match(ui, /export function NotificationCentre\(\{ userId \}\)/);
    assert.match(ui, /const unread = items\.filter\(\(item\) => !item\.read\)\.length;/);
    assert.match(ui, /aria-label=\{unread \? `Notifications, \$\{unread\} unread` : "Notifications"\}/);
    assert.match(ui, /\{unread > 0 && <span className="notification-unread-count"/);
  });

  it("[FUT-SPE-152] Mark all unread notices as read", async () => {
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
    const ui = source("../../src/components/ModerationNotifications.jsx");
    const api = source("../../src/lib/moderation.js");
    assert.match(api, /export const markAllModerationNotificationsRead = \(\) => call\("markAllModerationNotificationsRead"\);/);
    assert.match(ui, /<MarkAllReadButton unread=\{unread\} busy=\{busy\} onMarkAllRead=\{markAllRead\} \/>/);
  });

  it("[FUT-SPE-153] Notices deep-link to proposal or posting", async () => {
    assert.equal(notificationNavigationTarget({ contentType: "comment", proposalId: "a", problemId: "problem" }), "proposal/a");
    assert.equal(notificationNavigationTarget({ contentType: "proposal", contentId: "a" }), "proposal/a");
    assert.equal(notificationNavigationTarget({ contentType: "problem", contentId: "problem" }), "posting/problem");
    const db = fixture();
    await notifyProposalReceived({
      db, proposalId: "a", now,
      before: { status: "draft" },
      after: db.records.get("proposals/a"),
    });
    const notice = notices(db, "owner")[0];
    assert.equal(notice.navigationTarget, "proposal/a");
    assert.equal(notice.link, "#/proposal/a");
    const listed = await listModerationNotifications({ db, uid: "owner" });
    assert.equal(listed.items[0].navigationTarget, "proposal/a");
    const ui = source("../../src/components/ModerationNotifications.jsx");
    assert.match(ui, /const openRecord = \(target\) => \{ onNavigate\?\.\(\); go\(target\); \};/);
    assert.match(ui, /item\.kind === "matching" \|\| item\.kind === "approval_nearing_expiry"/);
  });

  it("[FUT-SPE-154] Owner notified when a proposal is submitted", async () => {
    const db = fixture();
    const after = db.records.get("proposals/a");
    const written = await notifyProposalReceived({
      db, proposalId: "a", now, before: { status: "draft" }, after,
    });
    assert.equal(written.written, true);
    const notice = notices(db, "owner")[0];
    assert.equal(notice.kind, "proposal_received");
    assert.equal(notice.recipientId, "owner");
    assert.match(notice.message, /Proposal A/);
    assert.equal((await notifyProposalReceived({
      db, proposalId: "a", now, before: { status: "submitted" }, after,
    })).written, false);
    assert.equal(notices(db, "owner").length, 1);
    assert.equal((await notifyProposalReceived({
      db, proposalId: "a", now, before: { status: "draft" }, after: { ...after, postingOwnerId: "" },
    })).written, false);
  });

  it("[FUT-SPE-155] Owner notified of a qualifying evaluator recommendation", async () => {
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
    assert.match(notice.message, /Recommend/);
    assert.equal(notice.navigationTarget, "proposal/a");
  });

  it("[FUT-SPE-156] Owner notified when an evaluator deletes the recommendation", async () => {
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
    assert.match(
      notices(db, "owner").find((row) => row.kind === "qualifying_recommendation_removed").message,
      /removed a qualifying recommendation/,
    );
  });

  it("[FUT-SPE-157] Owner reminded once when approval is nearing expiry", async () => {
    const db = fixture();
    db.records.get("problems/problem").matching = {
      status: "awaiting_confirmation",
      proposalId: "a",
      selectionId: "sel1",
      deadlineAt: later(12 * HOUR),
    };
    const first = await remindNearingApprovalWindows({ db, now });
    assert.equal(first.notified, 2);
    const ownerNotice = notices(db, "owner").find((row) => row.kind === "approval_nearing_expiry");
    assert.ok(ownerNotice);
    assert.equal(ownerNotice.navigationTarget, "posting/problem");
    assert.ok(notices(db, "alice").some((row) => row.kind === "approval_nearing_expiry"));
    assert.equal((await remindNearingApprovalWindows({ db, now: later(HOUR) })).notified, 0);
    assert.equal(notices(db).filter((row) => row.kind === "approval_nearing_expiry").length, 2);
    db.records.get("problems/problem").matching.status = "open";
    db.records.get("problems/problem").matching.deadlineAt = later(2 * HOUR);
    assert.equal((await remindNearingApprovalWindows({ db, now })).notified, 0);
  });
});
