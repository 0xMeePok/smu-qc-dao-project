import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { memoryDb } from "../../../firebase/functions/test/memoryDb.mjs";
import { createComment, deleteComment } from "../../../firebase/functions/comments.js";
import {
  listModerationNotifications,
  markAllModerationNotificationsRead,
  notifyProposalReceived,
} from "../../../firebase/functions/moderation.js";
import { remindNearingApprovalWindows } from "../../../firebase/functions/matchingNotifications.js";

/** QCDAO-68 - receive in-platform notifications for workflow events. */

const require = createRequire(new URL("../../../firebase/functions/package.json", import.meta.url));
const { Timestamp } = require("firebase-admin/firestore");
const now = Timestamp.fromMillis(1_800_000_000_000);
const later = (ms) => Timestamp.fromMillis(now.toMillis() + ms);
const HOUR = 60 * 60 * 1000;
const RECORD_TARGET = /^(posting|proposal)\/[A-Za-z0-9_-]{1,128}$/;

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

function recordLabel(item, target) {
  if (item.kind === "matching" || item.kind === "approval_nearing_expiry") return "View matching status";
  return target.startsWith("proposal/") ? "View proposal" : "View posting";
}

/** Mirrors NotificationCentre and the Profile notice feed after listModerationNotifications. */
function noticeFeedView(listed) {
  const items = (listed.items ?? []).map((item) => {
    const target = RECORD_TARGET.test(item?.navigationTarget || "") ? item.navigationTarget : null;
    return {
      id: item.id,
      read: Boolean(item.read),
      kind: item.kind,
      message: item.message,
      target,
      hash: target ? `#/${target}` : null,
      action: target ? recordLabel(item, target) : null,
      showMarkRead: !item.read,
    };
  });
  const unread = items.filter((item) => !item.read).length;
  return {
    empty: items.length === 0,
    unread,
    showMarkAllRead: unread > 0,
    showBadge: unread > 0,
    ariaLabel: unread ? `Notifications, ${unread} unread` : "Notifications",
    items,
  };
}

function headerCentreView({ signedIn, listed }) {
  if (!signedIn) return { showCentre: false };
  return { showCentre: true, ...noticeFeedView(listed) };
}

const listFor = (db, uid) => listModerationNotifications({ db, uid });
const kinds = (view) => view.items.map((item) => item.kind);
const byKind = (view, kind) => view.items.find((item) => item.kind === kind);

describe("[QCDAO-68] receive in-platform notifications for workflow events", () => {
  it("[FIT-SPE-052] Header centre shows unread notification badge", async () => {
    const db = fixture();
    await notifyProposalReceived({
      db, proposalId: "a", now, before: { status: "draft" }, after: db.records.get("proposals/a"),
    });
    const owner = headerCentreView({ signedIn: true, listed: await listFor(db, "owner") });
    assert.equal(owner.showCentre, true);
    assert.equal(owner.unread, 1);
    assert.equal(owner.showBadge, true);
    assert.equal(owner.showMarkAllRead, true);
    assert.equal(owner.ariaLabel, "Notifications, 1 unread");
    assert.equal(headerCentreView({ signedIn: false, listed: await listFor(db, "owner") }).showCentre, false);
    const researcher = headerCentreView({ signedIn: true, listed: await listFor(db, "alice") });
    assert.equal(researcher.unread, 0);
    assert.equal(researcher.showBadge, false);
    assert.equal(researcher.ariaLabel, "Notifications");
    assert.equal(researcher.empty, true);
  });

  it("[FIT-SPE-053] Mark all unread notices as read", async () => {
    const db = fixture();
    await notifyProposalReceived({
      db, proposalId: "a", now, before: { status: "draft" }, after: db.records.get("proposals/a"),
    });
    db.records.set("moderationNotifications/n-alice", {
      recipientId: "alice", createdAt: later(1000), readAt: null, kind: "matching",
      message: "Other member", navigationTarget: "posting/problem",
    });
    const before = noticeFeedView(await listFor(db, "owner"));
    assert.equal(before.showMarkAllRead, true);
    assert.equal(before.items.every((item) => item.showMarkRead), true);
    const result = await markAllModerationNotificationsRead({ db, uid: "owner", now: later(2000) });
    assert.equal(result.ok, true);
    const centre = headerCentreView({ signedIn: true, listed: await listFor(db, "owner") });
    const profile = noticeFeedView(await listFor(db, "owner"));
    assert.equal(centre.unread, 0);
    assert.equal(centre.showBadge, false);
    assert.equal(centre.showMarkAllRead, false);
    assert.equal(profile.showMarkAllRead, false);
    assert.ok(profile.items.every((item) => item.read && !item.showMarkRead));
    const other = noticeFeedView(await listFor(db, "alice"));
    assert.equal(other.unread, 1);
    assert.equal(other.showMarkAllRead, true);
  });

  it("[FIT-SPE-054] Notices deep-link to proposal or posting", async () => {
    const db = fixture();
    db.records.get("problems/problem").matching = {
      status: "awaiting_confirmation",
      proposalId: "a",
      selectionId: "sel1",
      deadlineAt: later(12 * HOUR),
    };
    await notifyProposalReceived({
      db, proposalId: "a", now, before: { status: "draft" }, after: db.records.get("proposals/a"),
    });
    await remindNearingApprovalWindows({ db, now });
    const owner = noticeFeedView(await listFor(db, "owner"));
    const received = byKind(owner, "proposal_received");
    const reminder = byKind(owner, "approval_nearing_expiry");
    assert.equal(received.target, "proposal/a");
    assert.equal(received.hash, "#/proposal/a");
    assert.equal(received.action, "View proposal");
    assert.equal(reminder.target, "posting/problem");
    assert.equal(reminder.hash, "#/posting/problem");
    assert.equal(reminder.action, "View matching status");
  });

  it("[FIT-SPE-055] Owner notified when a proposal is submitted", async () => {
    const db = fixture();
    await notifyProposalReceived({
      db, proposalId: "a", now, before: { status: "draft" }, after: db.records.get("proposals/a"),
    });
    const owner = noticeFeedView(await listFor(db, "owner"));
    const researcher = noticeFeedView(await listFor(db, "alice"));
    assert.ok(kinds(owner).includes("proposal_received"));
    assert.match(byKind(owner, "proposal_received").message, /Proposal A/);
    assert.equal(byKind(owner, "proposal_received").action, "View proposal");
    assert.equal(owner.unread, 1);
    assert.equal(researcher.empty, true);
    assert.equal((await notifyProposalReceived({
      db, proposalId: "a", now, before: { status: "submitted" }, after: db.records.get("proposals/a"),
    })).written, false);
    assert.equal((await listFor(db, "owner")).items.length, 1);
  });

  it("[FIT-SPE-056] Owner notified of a qualifying evaluator recommendation", async () => {
    const db = fixture();
    delete db.records.get("proposals/a").postingOwnerId;
    const created = await createComment({
      db, uid: "evaluator", proposalId: "a", now,
      body: "The claimed latency needs a cited benchmark.",
      recommendation: "recommend",
    });
    assert.equal(created.qualifying, true);
    const owner = noticeFeedView(await listFor(db, "owner"));
    const researcher = noticeFeedView(await listFor(db, "alice"));
    const evaluator = noticeFeedView(await listFor(db, "evaluator"));
    assert.ok(kinds(owner).includes("qualifying_recommendation"));
    assert.ok(kinds(owner).includes("evaluation_gate"));
    assert.ok(kinds(researcher).includes("qualifying_recommendation"));
    assert.equal(evaluator.empty, true);
    assert.equal(byKind(owner, "qualifying_recommendation").action, "View proposal");
    assert.equal(byKind(owner, "qualifying_recommendation").target, "proposal/a");
    assert.equal(owner.showBadge, true);
  });

  it("[FIT-SPE-057] Owner notified when an evaluator deletes the recommendation", async () => {
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
    const owner = noticeFeedView(await listFor(db, "owner"));
    const researcher = noticeFeedView(await listFor(db, "alice"));
    const evaluator = noticeFeedView(await listFor(db, "evaluator"));
    assert.ok(kinds(owner).includes("qualifying_recommendation_removed"));
    assert.equal(kinds(owner).includes("evaluation_gate"), false);
    assert.ok(kinds(researcher).includes("qualifying_recommendation_removed"));
    assert.equal(kinds(evaluator).includes("qualifying_recommendation_removed"), false);
    assert.equal(byKind(owner, "qualifying_recommendation_removed").action, "View proposal");
    assert.match(byKind(owner, "qualifying_recommendation_removed").message, /removed a qualifying recommendation/);
  });

  it("[FIT-SPE-058] Owner reminded once when approval is nearing expiry", async () => {
    const db = fixture();
    db.records.get("problems/problem").matching = {
      status: "awaiting_confirmation",
      proposalId: "a",
      selectionId: "sel1",
      deadlineAt: later(12 * HOUR),
    };
    assert.equal((await remindNearingApprovalWindows({ db, now })).notified, 2);
    const owner = noticeFeedView(await listFor(db, "owner"));
    const creator = noticeFeedView(await listFor(db, "alice"));
    const evaluator = noticeFeedView(await listFor(db, "evaluator"));
    assert.ok(kinds(owner).includes("approval_nearing_expiry"));
    assert.ok(kinds(creator).includes("approval_nearing_expiry"));
    assert.equal(evaluator.empty, true);
    assert.equal(byKind(owner, "approval_nearing_expiry").action, "View matching status");
    assert.equal(byKind(owner, "approval_nearing_expiry").target, "posting/problem");
    assert.equal((await remindNearingApprovalWindows({ db, now: later(HOUR) })).notified, 0);
    assert.equal((await listFor(db, "owner")).items.filter((item) => item.kind === "approval_nearing_expiry").length, 1);
    assert.equal((await listFor(db, "alice")).items.filter((item) => item.kind === "approval_nearing_expiry").length, 1);
  });
});
