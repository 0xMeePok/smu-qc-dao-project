import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { memoryDb } from "./memoryDb.mjs";
import { submitContentReport, listModerationQueue, getModerationContext, moderateContent,
  listModerationNotifications, markModerationNotificationRead, listReportableComments, moderationFlags } from "../moderation.js";
import { fundMockProposal, selectMockProposal, prepareModerationMatching } from "../matching.js";

const now = Timestamp.fromDate(new Date("2026-09-15T23:59:59.999Z"));
const later = ms => Timestamp.fromMillis(now.toMillis() + ms);
function fixture() {
  return memoryDb({
    "users/admin": { role: 1 }, "users/owner": { role: 0 }, "users/author": { role: 0 }, "users/member": { role: 0 },
    "users/suspended": { role: 1, suspended: true }, "users/stringAdmin": { role: "1" },
    "problems/p": { ownerId: "owner", status: "submitted", currency: "USDC", amount: 200,
      title: "Boundary problem", createdAt: now, expiresAt: later(30 * 86400000) },
    "proposals/a": { researcherId: "author", postingOwnerId: "owner", problemId: "p", status: "submitted",
      title: "Boundary proposal", currency: "USDC", amount: 100, createdAt: now, matching: { evaluationComplete: true } },
  });
}
const report = (db, patch = {}) => submitContentReport({ db, uid: "member", contentType: "problem", contentId: "p", reason: "other", now, ...patch });
const act = (db, patch = {}) => moderateContent({ db, uid: "admin", queueId: "problem_p", action: "hide", reason: "other", now, prepareMatching: prepareModerationMatching, ...patch });
const rows = (db, prefix) => [...db.records.entries()].filter(([key]) => key.startsWith(prefix + "/")).map(([, row]) => row);

test("report20 succeeds, report21 fails atomically, retries are free, exact UTC midnight resets limit", async () => {
  const db = fixture();
  for (let i = 0; i < 21; i++) db.records.set(`problems/p${i}`, { ownerId: "owner", status: "submitted" });
  for (let i = 0; i < 20; i++) await report(db, { contentId: `p${i}` });
  assert.equal(db.records.get("moderationReportLimits/member").count, 20);
  const state = [...db.records.entries()];
  await assert.rejects(() => report(db, { contentId: "p20" }), { code: "resource-exhausted" });
  assert.deepEqual([...db.records.entries()], state);
  assert.equal((await report(db, { contentId: "p0" })).alreadyReported, true);
  assert.equal(db.records.get("moderationReportLimits/member").count, 20);
  await report(db, { contentId: "p20", now: later(1) });
  assert.equal(db.records.get("moderationReportLimits/member").day, "2026-09-16");
  assert.equal(db.records.get("moderationReportLimits/member").count, 1);
  assert.equal(rows(db, "contentReports").length, 21);
});

test("report and moderation accept2000 trimmed characters and reject2001/nonstrings without writes", async () => {
  const db = fixture();
  await report(db, { details: `  ${"x".repeat(2000)}  ` });
  assert.equal(rows(db, "contentReports")[0].details.length, 2000);
  await act(db, { details: "x".repeat(2000) });
  for (const details of ["x".repeat(2001), 2000, {}, []]) {
    const before = [...db.records.entries()];
    await assert.rejects(() => report(db, { details }), { code: "invalid-argument" });
    await assert.rejects(() => act(db, { details }), { code: "invalid-argument" });
    assert.deepEqual([...db.records.entries()], before);
  }
});

test("content ID accepts128 characters;129, paths, inherited type names and missing content fail", async () => {
  const db = fixture(), id = "a".repeat(128);
  db.records.set(`problems/${id}`, { ownerId: "owner", status: "submitted" });
  await report(db, { contentId: id });
  for (const contentId of ["", "a".repeat(129), "a/b", "../p", null, 1])
    await assert.rejects(() => report(db, { contentId }), { code: "invalid-argument" });
  for (const contentType of ["constructor", "__proto__", "users"])
    await assert.rejects(() => report(db, { contentType }), { code: "invalid-argument" });
  await assert.rejects(() => report(db, { contentId: "missing" }), { code: "permission-denied" });
  assert.equal(rows(db, "contentReports").length, 1);
});

test("all moderation endpoints reject noauth, missing profiles and suspended administrators", async () => {
  const db = fixture();
  await report(db);
  for (const uid of [undefined, "missing", "suspended"]) {
    const code = uid ? "permission-denied" : "unauthenticated";
    for (const call of [() => report(db, { uid }), () => listModerationQueue({ db, uid }),
      () => getModerationContext({ db, uid, queueId: "problem_p" }), () => act(db, { uid }),
      () => listModerationNotifications({ db, uid }),
      () => markModerationNotificationRead({ db, uid, notificationId: "notice" }),
      () => listReportableComments({ db, uid, problemId: "p" })]) await assert.rejects(call, { code });
  }
  for (const uid of ["member", "stringAdmin"])
    await assert.rejects(() => listModerationQueue({ db, uid }), { code: "permission-denied" });
  assert.equal(rows(db, "moderationEvents").length, 0);
});

for (const sort of ["oldest", "most_reported"]) test(`queue ${sort} pagination handles49/50/51 tied rows with no duplicates`, async () => {
  for (const count of [49, 50, 51]) {
    const db = fixture();
    for (let i = count - 1; i >= 0; i--) db.records.set(`moderationQueue/comment_c${String(i).padStart(3, "0")}`, {
      contentType: "comment", status: "pending", createdAt: now, sortReports: -2, reportCount: 2,
    });
    const first = await listModerationQueue({ db, uid: "admin", sort });
    assert.equal(first.items.length, Math.min(50, count));
    assert.equal(Boolean(first.nextCursor), count > 50);
    if (first.nextCursor) {
      const second = await listModerationQueue({ db, uid: "admin", sort, cursor: first.nextCursor });
      assert.equal(second.items.length, 1);
      assert.equal(second.nextCursor, null);
      assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, count);
    }
  }
});

test("queue malformed filters and cursors reject without returning content", async () => {
  const db = fixture();
  for (const patch of [{ contentType: "users" }, { status: "visible" }, { sort: "newest" },
    { cursor: { id: "problem_p", value: "not-a-date" } }, { cursor: { id: "../p", value: now.toDate().toISOString() } },
    { sort: "most_reported", cursor: { id: "problem_p", value: 1.5 } },
    { sort: "most_reported", cursor: { id: "problem_p", value: "2" } }])
    await assert.rejects(() => listModerationQueue({ db, uid: "admin", ...patch }), { code: "invalid-argument" });
});

test("history/reports cap100 and queues/author notifications never expose reporter identities or notes", async () => {
  const db = fixture();
  await report(db, { details: "Private reporter details" });
  await act(db);
  for (let i = 0; i < 101; i++) {
    db.records.set(`contentReports/extra${i}`, { queueId: "problem_p", reporterId: `private${i}`, createdAt: later(i + 1) });
    db.records.set(`moderationEvents/extra${i}`, { queueId: "problem_p", sequence: i + 2, createdAt: later(i + 1) });
  }
  const context = await getModerationContext({ db, uid: "admin", queueId: "problem_p" });
  assert.equal(context.reports.length, 100); assert.equal(context.history.length, 100);
  assert.equal(context.reportsTruncated, true); assert.equal(context.historyTruncated, true);
  assert.doesNotMatch(JSON.stringify([await listModerationQueue({ db, uid: "admin", status: "all" }),
    await listModerationNotifications({ db, uid: "owner" })]), /reporterId|Private reporter details|private99/);
});

test("notifications cap50, isolate recipients and preserve first acknowledgement timestamp", async () => {
  const db = fixture();
  for (let i = 0; i < 51; i++) db.records.set(`moderationNotifications/n${i}`, {
    recipientId: "author", createdAt: later(i), readAt: null, contentType: "proposal", title: "Own content", action: "hide",
  });
  db.records.set("moderationNotifications/private", { recipientId: "owner", createdAt: later(100), message: "Private owner message" });
  const result = await listModerationNotifications({ db, uid: "author" });
  assert.equal(result.items.length, 50); assert.equal(result.truncated, true); assert.equal(result.items[0].id, "n50");
  assert.ok(result.items.every(row => row.recipientId === "author"));
  for (const notificationId of ["private", "missing"])
    await assert.rejects(() => markModerationNotificationRead({ db, uid: "author", notificationId, now }), { code: "permission-denied" });
  await markModerationNotificationRead({ db, uid: "author", notificationId: "n50", now });
  await markModerationNotificationRead({ db, uid: "author", notificationId: "n50", now: later(100) });
  assert.equal(db.records.get("moderationNotifications/n50").readAt.toMillis(), now.toMillis());
});

test("hide/remove/restore refunds each funder once, conserves sibling funds and restores proposal access", async () => {
  const db = fixture();
  db.records.set("proposals/b", { ...db.records.get("proposals/a"), researcherId: "owner", amount: 50 });
  for (const [uid, proposalId, amount, requestId] of [["member", "a", 33.33, "a_first_123456789"], ["owner", "a", 66.67, "a_second_123456789"], ["member", "b", 25, "b_first_123456789"]])
    await fundMockProposal({ db, uid, problemId: "p", proposalId, amount, requestId, now });
  await selectMockProposal({ db, uid: "owner", problemId: "p", proposalId: "a", rationale: "Meets all evaluation criteria", now });
  await report(db, { uid: "owner", contentType: "proposal", contentId: "a" });
  await act(db, { queueId: "proposal_a" });
  const refunded = rows(db, "mockFunding").filter(row => row.status === "refunded");
  assert.equal(refunded.length, 2); assert.equal(refunded.reduce((sum, row) => sum + row.amountMinor, 0), 10000);
  await act(db, { queueId: "proposal_a", action: "remove" });
  await act(db, { queueId: "proposal_a", action: "restore", reason: "appeal_accepted" });
  assert.equal(rows(db, "mockFunding").filter(row => row.status === "refunded").length, 2);
  assert.equal(db.records.get("problems/p").matching.totalFundedMinor, 2500);
  assert.equal(db.records.get("proposals/b").matching.fundedMinor, 2500);
  assert.equal(db.records.get("proposals/a").matching.fundedMinor, 0);
  assert.equal(db.records.get("proposals/a").postingOwnerId, "owner");
  assert.equal(db.records.get("proposals/a").status, "submitted");
  assert.deepEqual(rows(db, "moderationEvents").map(row => row.action), ["hide", "remove", "restore"]);
});

test("automatic triage has exact external-link and repeated-word thresholds", () => {
  assert.deepEqual(moderationFlags({ summary: Array(4).fill("https://example.test").join(" ") }), []);
  assert.deepEqual(moderationFlags({ summary: Array(5).fill("https://example.test").join(" ") }), ["many_external_links"]);
  assert.deepEqual(moderationFlags({ summary: Array(9).fill("word").join(" ") }), []);
  assert.deepEqual(moderationFlags({ summary: Array(10).fill("word").join(" ") }), ["repeated_text"]);
});

test("public comments beyond100 private comments remain reachable by cursor without private text leaks", async () => {
  const db = fixture();
  for (let i = 0; i < 100; i++) db.records.set(`comments/private${i}`, {
    authorId: "author", problemId: "p", proposalId: "a", text: "Private proposal discussion", createdAt: later(i),
  });
  db.records.set("comments/public", { authorId: "owner", problemId: "p", text: "Public discussion", createdAt: later(101) });
  const first = await listReportableComments({ db, uid: "member", problemId: "p" });
  assert.deepEqual(first.items, []); assert.ok(first.nextCursor);
  const next = await listReportableComments({ db, uid: "member", problemId: "p", cursor: first.nextCursor });
  assert.deepEqual(next.items.map(row => row.body), ["Public discussion"]); assert.equal(next.nextCursor, null);
  assert.doesNotMatch(JSON.stringify([first, next]), /Private proposal discussion/);
});

test("discussion page99/100/101 boundaries and tied timestamps produce no skips or duplicates", async () => {
  for (const count of [99, 100, 101]) {
    const db = fixture();
    for (let i = count - 1; i >= 0; i--) db.records.set(`comments/c${String(i).padStart(3, "0")}`, {
      authorId: "owner", problemId: "p", text: `Public ${i}`, createdAt: now,
    });
    const first = await listReportableComments({ db, uid: "member", problemId: "p" });
    assert.equal(first.items.length, Math.min(count, 100)); assert.equal(Boolean(first.nextCursor), count > 100);
    if (first.nextCursor) {
      const second = await listReportableComments({ db, uid: "member", problemId: "p", cursor: first.nextCursor });
      assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null);
      assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, count);
    }
  }
});

test("discussion cursor cannot bypass parent privacy and malformed cursors reject", async () => {
  const db = fixture(), cursor = { id: "private", value: now.toDate().toISOString() };
  await assert.rejects(() => listReportableComments({ db, uid: "member", problemId: "p", proposalId: "a", cursor }), { code: "permission-denied" });
  for (const bad of [{ id: "../private", value: cursor.value }, { id: "private", value: "bad" }, { id: "private", value: null }])
    await assert.rejects(() => listReportableComments({ db, uid: "member", problemId: "p", cursor: bad }), { code: "invalid-argument" });
});

test("queue and discussion cursors preserve submillisecond Firestore timestamp precision", async () => {
  const db = fixture(), precise = new Timestamp(now.seconds, 123456789);
  for (let i = 0; i < 101; i++) {
    const id = `c${String(i).padStart(3, "0")}`;
    db.records.set(`comments/${id}`, { authorId: "owner", problemId: "p", text: id, createdAt: precise });
    db.records.set(`moderationQueue/comment_${id}`, { contentType: "comment", status: "pending", createdAt: precise });
  }
  for (const [read, pageSize] of [
    [cursor => listModerationQueue({ db, uid: "admin", cursor }), 50],
    [cursor => listReportableComments({ db, uid: "member", problemId: "p", cursor }), 100],
  ]) {
    let cursor, seen = [];
    do {
      const result = await read(cursor);
      assert.ok(result.items.length <= pageSize);
      seen.push(...result.items.map(row => row.id));
      cursor = result.nextCursor;
      if (cursor) assert.equal(cursor.nanoseconds, 123456789);
      assert.ok(seen.length <= 101, "pagination must advance rather than repeat the first page");
    } while (cursor);
    assert.equal(seen.length, 101); assert.equal(new Set(seen).size, 101);
  }
});

test("timestamp cursors reject malformed seconds/nanoseconds and out-of-range dates", async () => {
  const db = fixture();
  for (const patch of [{ seconds: now.seconds }, { seconds: now.seconds, nanoseconds: -1 },
    { seconds: now.seconds, nanoseconds: 1e9 }, { seconds: 253402300800, nanoseconds: 0 },
    { seconds: now.seconds + 0.5, nanoseconds: 0 }, { value: "+100000-01-01T00:00:00Z" }, { value: null }]) {
    await assert.rejects(() => listModerationQueue({ db, uid: "admin", cursor: { id: "problem_p", ...patch } }), { code: "invalid-argument" });
    await assert.rejects(() => listReportableComments({ db, uid: "member", problemId: "p", cursor: { id: "c1", ...patch } }), { code: "invalid-argument" });
  }
});

test('members may report expired public postings while hidden expired content stays private', async () => {
  const db = fixture();
  db.records.get('problems/p').status = 'expired';
  await report(db);
  assert.equal(rows(db, 'contentReports').length, 1);
  await act(db);
  await assert.rejects(() => submitContentReport({ db, uid: 'author', contentType: 'problem', contentId: 'p', reason: 'misleading', now }), { code: 'permission-denied' });
});
