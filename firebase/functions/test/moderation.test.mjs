import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { memoryDb } from "./memoryDb.mjs";
import { submitContentReport, listModerationQueue, getModerationContext, moderateContent, flagSubmittedContent,
  listModerationNotifications, markModerationNotificationRead, listReportableComments } from "../moderation.js";
import { prepareModerationMatching, fundMockProposal, selectMockProposal, confirmMockProposal } from "../matching.js";

const now = Timestamp.fromMillis(1_800_000_000_000);
const later = (ms) => Timestamp.fromMillis(now.toMillis() + ms);
function fixture() {
  return memoryDb({
    "users/admin": { role: 1, fullName: "Moderator", organisation: "DAO" },
    "users/owner": { role: 0, fullName: "Problem owner", organisation: "Industry" },
    "users/alice": { role: 0, fullName: "Alice", organisation: "University" },
    "users/bob": { role: 0, fullName: "Bob", organisation: "University" },
    "users/funder": { role: 0 }, "users/suspended": { role: 1, suspended: true },
    "problems/problem": { ownerId: "owner", title: "Routing study", summary: "Improve routes", status: "submitted", currency: "USDC", amount: 200, expiresAt: later(30 * 86400000), createdAt: now },
    "proposals/a": { researcherId: "alice", postingOwnerId: "owner", problemId: "problem", title: "Proposal A", summary: "A routing approach", amount: 100, currency: "USDC", status: "submitted", createdAt: now, matching: { evaluationComplete: true } },
    "proposals/b": { researcherId: "bob", postingOwnerId: "owner", problemId: "problem", title: "Proposal B", summary: "Another approach", amount: 100, currency: "USDC", status: "submitted", createdAt: now, matching: { evaluationComplete: true } },
    "comments/comment": { authorId: "alice", problemId: "problem", text: "A community discussion", createdAt: now },
  });
}
const report = (db, patch = {}) => submitContentReport({ db, uid: "owner", contentType: "proposal", contentId: "a", reason: "misleading", details: "Please check the claimed result.", now, ...patch });
const queue = (db, patch = {}) => listModerationQueue({ db, uid: "admin", ...patch });
const act = (db, action = "hide", patch = {}) => moderateContent({ db, uid: "admin", queueId: "proposal_a", action, reason: "misleading", now, prepareMatching: prepareModerationMatching, ...patch });
const fund = (db, proposalId, amount = 100) => fundMockProposal({ db, uid: "funder", problemId: "problem", proposalId, amount, requestId: `fund_request_${proposalId}_1234567`, now });
const select = (db) => selectMockProposal({ db, uid: "owner", problemId: "problem", proposalId: "a", rationale: "The strongest evaluated approach.", now });

test("reports use existing content access, enforce one per member/item, and aggregate reasons atomically", async () => {
  const db = fixture();
  await assert.rejects(() => report(db, { uid: "funder" }), { code: "permission-denied" });
  await assert.rejects(() => report(db, { uid: "missing" }), { code: "permission-denied" });
  await assert.rejects(() => report(db, { uid: "suspended" }), { code: "permission-denied" });
  const [one, retry] = await Promise.all([report(db), report(db)]);
  assert.equal(one.alreadyReported, false);
  assert.equal(retry.alreadyReported, true);
  await report(db, { uid: "alice", reason: "duplicate" });
  const state = await queue(db);
  assert.equal(state.pendingCount, 1);
  assert.equal(state.items[0].reportCount, 2);
  assert.deepEqual(state.items[0].reportReasons, { misleading: 1, duplicate: 1 });
  assert.equal(state.items[0].organisation, "University");
  assert.equal(state.items[0].authorName, "Alice");
  assert.equal(Object.hasOwn(state.items[0], "reporterId"), false);
  const context = await getModerationContext({ db, uid: "admin", queueId: "proposal_a" });
  assert.deepEqual(context.reports.map((item) => item.reporterId).sort(), ["alice", "owner"]);
  assert.equal(context.parent.title, "Routing study");
  await assert.rejects(() => getModerationContext({ db, uid: "alice", queueId: "proposal_a" }), { code: "permission-denied" });
  await assert.rejects(() => queue(db, { uid: "owner" }), { code: "permission-denied" });
});

test("automatic screening skips drafts, is idempotent, and never changes content visibility", async () => {
  const db = fixture();
  const text = "https://one.test https://two.test https://three.test https://four.test https://five.test";
  db.records.set("problems/draft", { ownerId: "owner", status: "draft", summary: text });
  assert.equal((await flagSubmittedContent({ db, contentType: "problem", contentId: "draft", now })).flagged, false);
  db.records.get("proposals/a").summary = text;
  assert.equal((await flagSubmittedContent({ db, contentType: "proposal", contentId: "a", now })).flagged, true);
  assert.equal((await flagSubmittedContent({ db, contentType: "proposal", contentId: "a", now })).flagged, false);
  assert.equal(db.records.get("proposals/a").status, "submitted");
  assert.equal((await queue(db)).pendingCount, 1);
  await act(db, "restore", { reason: "no_violation" });
  assert.equal((await queue(db)).pendingCount, 0);
  await flagSubmittedContent({ db, contentType: "proposal", contentId: "a", now });
  assert.equal((await queue(db)).pendingCount, 0); // retried trigger cannot reopen a reviewed item
  db.records.get("proposals/a").title = "Changed spam content";
  await flagSubmittedContent({ db, contentType: "proposal", contentId: "a", now: later(1000) });
  assert.equal((await queue(db)).items[0].title, "Changed spam content");
});

test("admin hide/remove/restore preserves original workflow and sponsor access with immutable history and private notifications", async () => {
  const db = fixture();
  await report(db);
  await assert.rejects(() => act(db, "hide", { uid: "alice" }), { code: "permission-denied" });
  await assert.rejects(() => act(db, "hide", { uid: "suspended" }), { code: "permission-denied" });
  await assert.rejects(() => act(db, "hide", { reason: "" }), { code: "invalid-argument" });
  await act(db);
  assert.equal(db.records.get("proposals/a").status, "moderated_hidden");
  assert.equal(db.records.get("proposals/a").postingOwnerId, "");
  assert.equal(db.records.get("proposals/a").moderation.originalPostingOwnerId, "owner");
  assert.equal((await queue(db)).pendingCount, 0);
  assert.equal((await act(db)).unchanged, true);
  await act(db, "remove", { now: later(1000) });
  await act(db, "restore", { reason: "appeal_accepted", now: later(2000) });
  assert.equal(db.records.get("proposals/a").status, "submitted");
  assert.equal(db.records.get("proposals/a").postingOwnerId, "owner");
  assert.equal(db.records.get("proposals/a").moderationStatus, "visible");
  const context = await getModerationContext({ db, uid: "admin", queueId: "proposal_a" });
  assert.deepEqual(context.history.map((item) => item.action), ["hide", "remove", "restore"]);
  assert.ok(context.history.every((item) => item.chainStatus === "pending"));
  const notifications = await listModerationNotifications({ db, uid: "alice" });
  assert.equal(notifications.items.length, 3);
  assert.match(notifications.items[0].message, /proposal/);
  assert.equal((await listModerationNotifications({ db, uid: "owner" })).items.length, 0);
  await assert.rejects(() => markModerationNotificationRead({ db, uid: "bob", notificationId: notifications.items[0].id, now }), { code: "permission-denied" });
  await markModerationNotificationRead({ db, uid: "alice", notificationId: notifications.items[0].id, now });
  assert.equal((await listModerationNotifications({ db, uid: "alice" })).items[0].read, true);
});

test("hiding a selected proposal refunds only its funders atomically and restoration permits evaluated re-funding", async () => {
  const db = fixture();
  await fund(db, "a"); await fund(db, "b", 40); await select(db); await report(db);
  await act(db);
  assert.equal(db.records.get("problems/problem").matching.status, "open");
  assert.equal(db.records.get("problems/problem").matching.totalFundedMinor, 4000);
  const ledger = [...db.records.entries()].filter(([path]) => path.startsWith("mockFunding/")).map(([, row]) => row);
  assert.equal(ledger.find((row) => row.proposalId === "a").status, "refunded");
  assert.equal(ledger.find((row) => row.proposalId === "b").status, "pledged");
  await act(db, "restore", { reason: "appeal_accepted", now: later(1000) });
  const restored = db.records.get("proposals/a");
  assert.equal(restored.matching.status, "funding");
  assert.equal(restored.matching.fundedMinor, 0);
  assert.equal(restored.matching.evaluationComplete, true);
  await fundMockProposal({ db, uid: "funder", problemId: "problem", proposalId: "a", amount: 100, requestId: "fund_restored_proposal_a", now: later(2000) });
  assert.equal(db.records.get("problems/problem").matching.totalFundedMinor, 14000);
});

test("hiding a whole problem refunds all pledged funds but never releases confirmed locked funds", async () => {
  const db = fixture();
  await fund(db, "a"); await fund(db, "b"); await select(db);
  await report(db, { contentType: "problem", contentId: "problem", uid: "funder" });
  await act(db, "hide", { queueId: "problem_problem" });
  assert.equal(db.records.get("problems/problem").matching.totalFundedMinor, 0);
  assert.ok([...db.records.entries()].filter(([path]) => path.startsWith("mockFunding/")).every(([, row]) => row.status === "refunded"));
  await act(db, "restore", { queueId: "problem_problem", reason: "appeal_accepted" });
  assert.equal(db.records.get("proposals/a").matching.fundedMinor, 0);
  const locked = fixture();
  await fund(locked, "a"); await select(locked);
  await confirmMockProposal({ db: locked, uid: "alice", problemId: "problem", proposalId: "a", now });
  await report(locked);
  await act(locked);
  assert.equal(locked.records.get("problems/problem").matching.status, "confirmed");
  assert.equal(locked.records.get("proposals/a").matching.status, "confirmed");
  assert.ok([...locked.records.entries()].filter(([path]) => path.startsWith("mockFunding/")).every(([, row]) => row.status === "locked"));
});

test("comments inherit parent access and support report/hide/restore without a commenting write API", async () => {
  const db = fixture();
  db.records.set("comments/private", { authorId: "alice", problemId: "problem", proposalId: "a", text: "Private proposal comment", createdAt: now });
  assert.equal((await listReportableComments({ db, uid: "funder", problemId: "problem" })).items.length, 1);
  await assert.rejects(() => listReportableComments({ db, uid: "funder", problemId: "problem", proposalId: "a" }), { code: "permission-denied" });
  await assert.rejects(() => listReportableComments({ db, uid: "owner", problemId: "wrong", proposalId: "a" }), { code: "permission-denied" });
  assert.equal((await listReportableComments({ db, uid: "owner", problemId: "problem", proposalId: "a" })).items[0].body, "Private proposal comment");
  await report(db, { uid: "funder", contentType: "comment", contentId: "comment", reason: "off_topic" });
  assert.equal((await listReportableComments({ db, uid: "funder", problemId: "problem" })).items.length, 1);
  await act(db, "hide", { queueId: "comment_comment", reason: "off_topic" });
  assert.equal((await listReportableComments({ db, uid: "funder", problemId: "problem" })).items.length, 0);
  assert.equal((await listReportableComments({ db, uid: "alice", problemId: "problem" })).items.length, 1);
  await assert.rejects(() => report(db, { uid: "bob", contentType: "comment", contentId: "comment" }), { code: "permission-denied" });
  await act(db, "restore", { queueId: "comment_comment", reason: "no_violation" });
  assert.equal((await listReportableComments({ db, uid: "funder", problemId: "problem" })).items.length, 1);
  db.records.get("problems/problem").status = "draft";
  await assert.rejects(() => listReportableComments({ db, uid: "funder", problemId: "problem" }), { code: "permission-denied" });
});

test("queue type/status filters, report-count ordering and cursor paging stay bounded", async () => {
  const db = fixture();
  await report(db);
  await report(db, { contentType: "problem", contentId: "problem" });
  await report(db, { uid: "funder", contentType: "problem", contentId: "problem" });
  assert.equal((await queue(db, { sort: "most_reported" })).items[0].contentType, "problem");
  assert.equal((await queue(db, { contentType: "proposal" })).items.length, 1);
  await act(db);
  assert.equal((await queue(db, { status: "hidden" })).items.length, 1);
  for (let i = 0; i < 55; i++) db.records.set(`moderationQueue/comment_c${String(i).padStart(2, "0")}`, {
    contentType: "comment", status: "pending", createdAt: later(i), sortReports: 0, reportCount: 0,
  });
  const first = await queue(db, { contentType: "comment" });
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  const second = await queue(db, { contentType: "comment", cursor: first.nextCursor });
  assert.equal(second.items.length, 5);
  assert.equal(new Set([...first.items, ...second.items].map((row) => row.id)).size, 55);
});

test("report validation and daily limit bound distinct-report abuse without penalising retries", async () => {
  const db = fixture();
  await assert.rejects(() => report(db, { reason: "invented" }), { code: "invalid-argument" });
  await assert.rejects(() => report(db, { details: "x".repeat(2001) }), { code: "invalid-argument" });
  await assert.rejects(() => report(db, { contentId: "../private" }), { code: "invalid-argument" });
  for (let i = 0; i < 20; i++) {
    db.records.set(`problems/p${i}`, { ownerId: "owner", status: "submitted" });
    await report(db, { uid: "funder", contentType: "problem", contentId: `p${i}` });
  }
  await assert.rejects(() => report(db, { uid: "funder", contentType: "problem", contentId: "problem" }), { code: "resource-exhausted" });
  assert.equal((await report(db, { uid: "funder", contentType: "problem", contentId: "p0" })).alreadyReported, true);
  assert.equal((await report(db, { uid: "funder", contentType: "problem", contentId: "problem", now: later(86400000) })).ok, true);
});
