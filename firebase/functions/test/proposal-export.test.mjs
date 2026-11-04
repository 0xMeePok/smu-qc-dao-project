import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { memoryDb } from "./memoryDb.mjs";
import {
  CSV_COLUMNS,
  EXPORT_COMMENT_PAGE_SIZE,
  EXPORT_PAGE_BYTES,
  EXPORT_SESSION_BYTES,
  EXPORT_SESSION_COLLECTION,
  EXPORT_SESSION_TTL_MS,
  exportToCsv,
  EXPORT_NOTICE,
  EXPORT_SCAN_CAP,
  EXPORT_SCHEMA_VERSION,
  exportSelectedProposals,
} from "../proposalExport.js";

const schema = JSON.parse(readFileSync(new URL("../../../docs/schemas/selected-proposal-export.schema.json", import.meta.url), "utf8"));
const at = (iso) => Timestamp.fromDate(new Date(iso));
const actor = { actorUid: "0xadmin", actorName: "Ada Admin" };

function posting(id, extra = {}) {
  return {
    ownerId: "0xowner",
    organisation: "QC Lab",
    title: `Posting ${id}`,
    summary: `Summary ${id}`,
    status: "submitted",
    opportunityType: "business-problem",
    categories: ["routing"],
    amount: 1000,
    currency: "SGD",
    hasAcceptedSolution: true,
    acceptedProposalId: `proposal-${id}`,
    createdAt: at("2026-09-01T00:00:00.000Z"),
    updatedAt: at("2026-10-02T00:00:00.000Z"),
    expiresAt: at("2026-12-01T00:00:00.000Z"),
    ...extra,
  };
}

function proposal(id, extra = {}) {
  return {
    researcherId: "0xresearcher",
    problemId: id.replace("proposal-", "posting-").replace(/^proposal/, "posting"),
    title: `Proposal ${id}`,
    summary: `Approach ${id}`,
    status: "accepted",
    amount: 1000,
    currency: "SGD",
    category: "annealing",
    createdAt: at("2026-09-15T00:00:00.000Z"),
    updatedAt: at("2026-10-02T00:00:00.000Z"),
    ...extra,
  };
}

function comment(extra = {}) {
  return {
    authorId: "0xmember",
    authorRole: "user",
    badge: null,
    recommendation: null,
    body: "A public comment.",
    parentId: null,
    qualifying: false,
    moderationStatus: "visible",
    createdAt: at("2026-10-03T00:00:00.000Z"),
    updatedAt: at("2026-10-03T00:00:00.000Z"),
    ...extra,
  };
}

function store(records) {
  return memoryDb(records);
}

async function exportOf(db, input, now = at("2026-10-27T08:00:00.000Z")) {
  let page = await exportSelectedProposals({ db, ...actor, input: { protocolVersion: 1, ...input }, now });
  const document = { ...page.document, postings: [] };
  const postings = new Map();
  while (true) {
    assertConforms(schema, page.document, "page.document.");
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= EXPORT_PAGE_BYTES);
    for (const row of page.document.postings) {
      const key = page.postingIndex;
      if (!postings.has(key)) postings.set(key, { ...row, proposals: [] });
      const posting = postings.get(key);
      for (const proposal of row.proposals) {
        let selected = posting.proposals.find((existing) => existing.id === proposal.id);
        if (!selected) { selected = { ...proposal, comments: [] }; posting.proposals.push(selected); }
        selected.comments.push(...proposal.comments);
      }
    }
    if (page.done) break;
    page = await exportSelectedProposals({ db, ...actor, input: page.nextCursor, now });
  }
  document.postings = [...postings.values()];
  for (const posting of document.postings) {
    posting.proposals.sort((a, b) => a.id.localeCompare(b.id));
    for (const proposal of posting.proposals) proposal.comments.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || "") || a.id.localeCompare(b.id));
  }
  Object.assign(document, page.totals);
  return { ...page, ...page.totals, document, csv: exportToCsv(document) };
}

function audits(db) {
  return [...db.records.entries()].filter(([path]) => path.startsWith("audits/"));
}

function typeMatches(types, value) {
  return types.some((type) => {
    if (type === "null") return value == null;
    if (type === "array") return Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  });
}

function assertConforms(node, value, path, root = schema) {
  if (node.$ref) {
    const name = node.$ref.replace("#/$defs/", "");
    assertConforms(root.$defs[name], value, path, root);
    return;
  }
  if (node.oneOf || node.anyOf) {
    const options = node.oneOf || node.anyOf;
    const errors = [];
    for (const option of options) {
      try {
        assertConforms(option, value, path, root);
        return;
      } catch (error) {
        errors.push(error.message);
      }
    }
    assert.fail(`${path} matched no schema branch:\n${errors.join("\n")}`);
  }
  if (Object.hasOwn(node, "const")) {
    assert.deepEqual(value, node.const, path);
    return;
  }
  if (node.enum) {
    assert.ok(node.enum.includes(value), `${path} value ${JSON.stringify(value)} is not in the schema`);
    return;
  }
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  if (types.length && !typeMatches(types, value)) {
    assert.fail(`${path} expected ${types.join("|")} but was ${JSON.stringify(value)}`);
  }
  if (types.includes("object") || node.properties) {
    for (const key of node.required || []) assert.ok(Object.hasOwn(value, key), `${path}${key} is required`);
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) assert.ok(node.properties?.[key], `${path}${key} is not in the published schema`);
    }
    for (const [key, child] of Object.entries(node.properties || {})) {
      if (!Object.hasOwn(value, key)) continue;
      assertConforms(child, value[key], `${path}${key}.`, root);
    }
    return;
  }
  if (types.includes("array")) {
    for (const [index, item] of value.entries()) assertConforms(node.items, item, `${path}[${index}].`, root);
  }
}

describe("QCDAO-107 selected proposal export", () => {
  it("publishes a schema that matches the JSON file and the CSV columns", async () => {
    assert.equal(schema["x-schema-version"], EXPORT_SCHEMA_VERSION);
    assert.deepEqual(schema["x-csv-columns"], [...CSV_COLUMNS]);
    const db = store({
      "problems/posting-a": posting("posting-a"),
      "proposals/proposal-posting-a": proposal("proposal-posting-a", { problemId: "posting-a" }),
      "comments/eval": comment({
        proposalId: "proposal-posting-a",
        problemId: "posting-a",
        authorId: "0xevaluator",
        authorRole: "evaluator",
        badge: "evaluator",
        recommendation: "recommend_with_revisions",
        qualifying: true,
        body: "=SUM(A1)\nHe said \"revise\".",
      }),
    });
    const { document, csv } = await exportOf(db, { proposalId: "proposal-posting-a" });
    assertConforms(schema, document, "document.");
    assert.equal(csv.split("\r\n")[0], CSV_COLUMNS.join(","));
    assert.match(csv, /"'=SUM\(A1\)/);
    assert.equal(document.postings[0].proposals[0].comments[0].body.startsWith("=SUM(A1)"), true);
  });

  it("exports one accepted posting as JSON and CSV, including the evaluator badge and recommendation", async () => {
    const db = store({
      "problems/posting-a": posting("posting-a"),
      "proposals/proposal-posting-a": proposal("proposal-posting-a", { problemId: "posting-a", title: "Annealing study" }),
      "proposals/other": proposal("other", { problemId: "posting-a", status: "submitted", title: "Not selected" }),
      "comments/member": comment({ proposalId: "proposal-posting-a", problemId: "posting-a", authorId: "0xmember", body: "Looks promising." }),
      "comments/eval": comment({
        proposalId: "proposal-posting-a",
        problemId: "posting-a",
        authorId: "0xevaluator",
        authorRole: "evaluator",
        badge: "evaluator",
        recommendation: "recommend",
        qualifying: true,
        body: "Recommend this approach.",
        createdAt: at("2026-10-04T00:00:00.000Z"),
      }),
      "comments/reply": comment({
        proposalId: "proposal-posting-a",
        parentId: "eval",
        authorId: "0xresearcher",
        authorRole: "user",
        body: "Thanks, the revision is in.",
        createdAt: at("2026-10-05T00:00:00.000Z"),
      }),
      "comments/removed": comment({
        proposalId: "proposal-posting-a",
        authorId: "0xevaluator",
        authorRole: "evaluator",
        badge: "evaluator",
        recommendation: "do_not_recommend",
        body: "Withdrawn after reading the appendix.",
        deletedAt: at("2026-10-06T00:00:00.000Z"),
        moderationStatus: "removed",
        qualifying: false,
        createdAt: at("2026-10-06T00:00:00.000Z"),
      }),
      "comments/sibling": comment({ proposalId: "other", body: "This comment is on another proposal." }),
    });
    const result = await exportOf(db, { proposalId: "proposal-posting-a" });
    assert.equal(result.document.notice, EXPORT_NOTICE);
    assert.equal(result.document.scope.mode, "proposal");
    assert.equal(result.document.scope.proposalId, "proposal-posting-a");
    assert.equal(result.document.postings[0].proposals[0].accepted, true);
    assert.equal(result.postingCount, 1);
    assert.equal(result.proposalCount, 1);
    assert.equal(result.commentCount, 4);
    const [exported] = result.document.postings;
    assert.equal(exported.workflowStatus, "decision_recorded");
    assert.equal(exported.proposals[0].id, "proposal-posting-a");
    assert.equal(exported.proposals[0].workflowStatus, "accepted");
    assert.equal(exported.proposals[0].title, "Annealing study");
    const evaluator = exported.proposals[0].comments.find((row) => row.id === "eval");
    assert.equal(evaluator.authorId, "0xevaluator");
    assert.equal(evaluator.authorRole, "evaluator");
    assert.equal(evaluator.badge, "evaluator");
    assert.equal(evaluator.recommendation, "recommend");
    assert.equal(evaluator.recommendationLabel, "Recommend");
    assert.equal(evaluator.qualifying, true);
    const removed = exported.proposals[0].comments.find((row) => row.id === "removed");
    assert.equal(removed.recommendation, "do_not_recommend");
    assert.equal(removed.recommendationLabel, "Do not recommend");
    assert.equal(removed.deletedAt, "2026-10-06T00:00:00.000Z");
    assert.equal(JSON.stringify(result.document).includes("another proposal"), false);
    assert.equal(JSON.stringify(result.document).includes("qftGrade"), false);
    assert.match(result.csv, /0xevaluator,evaluator,evaluator,recommend,Recommend/);
    const [auditPath, audit] = audits(db)[0];
    assert.equal(auditPath.startsWith("audits/"), true);
    assert.equal(audit.type, "proposal_comment_export");
    assert.equal(audit.action, "PROPOSAL_COMMENT_EXPORT");
    assert.equal(audit.actor, "0xadmin");
    assert.equal(audit.actorName, "Ada Admin");
    assert.equal(audit.scope, "proposal");
    assert.equal(audit.postingId, "posting-a");
    assert.equal(audit.problemId, "posting-a");
    assert.equal(audit.commentCount, 4);
    assert.equal(audit.schemaVersion, EXPORT_SCHEMA_VERSION);
    assert.equal(audit.timestamp.toDate().toISOString(), "2026-10-27T08:00:00.000Z");
    assert.equal(result.auditId, auditPath.split("/")[1]);
  });

  it("returns every accepted posting in a date range and leaves the others out", async () => {
    const db = store({
      "problems/early": posting("early", { acceptedProposalId: "early-proposal", updatedAt: at("2026-10-02T00:00:00.000Z") }),
      "proposals/early-proposal": proposal("early-proposal", { problemId: "early", createdAt: at("2026-10-02T00:00:00.000Z"), updatedAt: at("2026-10-02T00:00:00.000Z") }),
      "comments/early-note": comment({ proposalId: "early-proposal", authorId: "0xearly" }),
      "problems/late": posting("late", { acceptedProposalId: "late-proposal", updatedAt: at("2026-11-02T00:00:00.000Z") }),
      "proposals/late-proposal": proposal("late-proposal", { problemId: "late", createdAt: at("2026-11-02T00:00:00.000Z"), updatedAt: at("2026-11-02T00:00:00.000Z") }),
      "comments/late-note": comment({ proposalId: "late-proposal", authorId: "0xlate" }),
      "problems/open": { ...posting("open", { hasAcceptedSolution: false, acceptedProposalId: null, opportunityType: "open-funding" }), title: "Grant call" },
      "proposals/grant-in": proposal("grant-in", { problemId: "open", createdAt: at("2026-10-20T00:00:00.000Z"), updatedAt: at("2026-10-20T00:00:00.000Z"), title: "In range grant" }),
      "proposals/grant-out": proposal("grant-out", { problemId: "open", createdAt: at("2026-11-20T00:00:00.000Z"), updatedAt: at("2026-11-20T00:00:00.000Z"), title: "Later grant" }),
      "problems/live": posting("live", { hasAcceptedSolution: false, acceptedProposalId: "", title: "Still open" }),
      "proposals/not-accepted": proposal("not-accepted", { problemId: "live", status: "submitted", createdAt: at("2026-10-15T00:00:00.000Z"), title: "Not accepted yet" }),
      "comments/live-note": comment({ proposalId: "not-accepted", authorId: "0xmember", body: "A comment before acceptance." }),
      "comments/grant-note": comment({
        proposalId: "grant-in",
        authorId: "0xevaluator",
        authorRole: "evaluator",
        badge: "evaluator",
        recommendation: "recommend_with_revisions",
        qualifying: true,
        body: "Recommend with the stated caveat.",
      }),
    });
    const { document, csv } = await exportOf(db, { startDate: "2026-10-01", endDate: "2026-10-27" });
    assert.deepEqual(document.postings.map((row) => row.id), ["live", "early", "open"]);
    const live = document.postings.find((row) => row.id === "live");
    assert.equal(live.proposals[0].accepted, false);
    assert.equal(live.proposals[0].comments[0].body, "A comment before acceptance.");
    const grant = document.postings.find((row) => row.id === "open");
    assert.deepEqual(grant.proposals.map((row) => row.id), ["grant-in"]);
    assert.equal(grant.proposals[0].accepted, true);
    const grantComment = grant.proposals[0].comments[0];
    assert.equal(grantComment.badge, "evaluator");
    assert.equal(grantComment.recommendation, "recommend_with_revisions");
    assert.equal(grantComment.recommendationLabel, "Recommend with revisions");
    assert.equal(csv.includes("0xlate"), false);
    assert.equal(csv.includes("Later grant"), false);
    const audit = audits(db)[0][1];
    assert.equal(audit.scope, "range");
    assert.equal(audit.startDate, "2026-10-01");
    assert.equal(audit.endDate, "2026-10-27");
    assert.equal(audit.postingId, null);
    assert.equal(audit.problemId, null);
    assert.deepEqual(audit.postingIds, ["live", "early", "open"]);
    assert.equal(audit.actor, "0xadmin");
    assert.ok(audit.timestamp);
    const acceptedOnly = await exportOf(db, { startDate: "2026-10-01", endDate: "2026-10-27", acceptance: "accepted" });
    assert.deepEqual(acceptedOnly.document.postings.map((row) => row.id), ["early", "open"]);
    assert.equal(acceptedOnly.document.scope.acceptance, "accepted");
  });

  it("includes a mock confirmation whose proposal status is still submitted", async () => {
    const db = store({
      "problems/mock": {
        ...posting("mock", { hasAcceptedSolution: false, acceptedProposalId: null }),
        matching: { status: "confirmed", proposalId: "mock-proposal", confirmedAt: at("2026-10-11T00:00:00.000Z") },
      },
      "proposals/mock-proposal": proposal("mock-proposal", {
        problemId: "mock",
        status: "submitted",
        matching: { status: "confirmed" },
      }),
      "comments/mock-note": comment({ proposalId: "mock-proposal", body: "Noted." }),
    });
    const { document } = await exportOf(db, { proposalId: "mock-proposal" });
    assert.equal(document.postings[0].acceptedAt, "2026-10-11T00:00:00.000Z");
    assert.equal(document.postings[0].proposals[0].workflowStatus, "accepted");
    assert.equal(document.commentCount, 1);
  });

  it("keeps a proposal that has no comments, and records an empty range", async () => {
    const db = store({
      "problems/quiet": posting("quiet"),
      "proposals/proposal-quiet": proposal("proposal-quiet", { problemId: "quiet" }),
    });
    const single = await exportOf(db, { proposalId: "proposal-quiet" });
    assert.equal(single.commentCount, 0);
    const lines = single.csv.trim().split("\r\n");
    assert.equal(lines.length, 2);
    assert.match(lines[1], /quiet,.*proposal-quiet/);
    const empty = store({});
    const range = await exportOf(empty, { startDate: "2026-01-01", endDate: "2026-01-02" });
    assert.deepEqual(range.document.postings, []);
    assert.equal(range.csv, `${CSV_COLUMNS.join(",")}\r\n`);
    assert.equal(audits(empty).length, 1);
    assert.equal(audits(empty)[0][1].postingCount, 0);
  });

  it("refuses a draft, a missing proposal, a future end date, and a malformed request", async () => {
    const db = store({
      "problems/open": posting("open", { hasAcceptedSolution: false, acceptedProposalId: "" }),
      "proposals/still-open": proposal("still-open", { problemId: "open", status: "submitted" }),
      "proposals/draft": proposal("draft", { problemId: "open", status: "draft" }),
    });
    const drafted = await exportOf(db, { proposalId: "still-open" });
    assert.equal(drafted.document.postings[0].proposals[0].accepted, false);
    await assert.rejects(() => exportOf(db, { proposalId: "draft" }), (error) => error instanceof HttpsError && error.code === "failed-precondition");
    await assert.rejects(() => exportOf(db, { proposalId: "missing" }), (error) => error instanceof HttpsError && error.code === "not-found");
    await assert.rejects(() => exportOf(db, {}), (error) => error instanceof HttpsError && error.code === "invalid-argument");
    await assert.rejects(() => exportOf(db, { proposalId: "still-open", startDate: "2026-10-01", endDate: "2026-10-02" }), (error) => error instanceof HttpsError && error.code === "invalid-argument");
    await assert.rejects(() => exportOf(db, { startDate: "2026-10-02", endDate: "2026-10-01" }), (error) => error instanceof HttpsError && error.code === "invalid-argument");
    await assert.rejects(() => exportOf(db, { startDate: "2026-10-01", endDate: "2026-10-28" }), (error) => error instanceof HttpsError && error.code === "invalid-argument");
    await assert.rejects(() => exportOf(db, { startDate: "2026-13-01", endDate: "2026-13-02" }), (error) => error instanceof HttpsError && error.code === "invalid-argument");
    assert.equal(audits(db).length, 1);
  });

  it("exports 1001 comments through bounded pages without a partial extract", async () => {
    const records = {
      "problems/full": posting("full"),
      "proposals/proposal-full": proposal("proposal-full", { problemId: "full" }),
    };
    for (let index = 0; index <= 1000; index += 1) {
      records[`comments/c${index}`] = comment({ proposalId: "proposal-full", body: `note ${index}` });
    }
    const db = store(records);
    const result = await exportOf(db, { proposalId: "proposal-full" });
    assert.equal(result.commentCount, 1001);
    assert.equal(new Set(result.document.postings[0].proposals[0].comments.map((row) => row.id)).size, 1001);
    assert.equal(audits(db).length, 1);
    assert.equal(audits(db)[0][1].commentCount, 1001);
    assert.ok(EXPORT_SCAN_CAP >= 1);
  });
});

const exportNow = at("2026-10-27T08:00:00.000Z");
const beginInput = (extra = {}) => ({ protocolVersion: 1, proposalId: "selected", requestId: "export-request-0001", ...extra });
const callPage = (db, input, extra = {}) => exportSelectedProposals({ db, ...actor, now: exportNow, input, ...extra });
function floodRecords(count, extra = {}) {
  const records = { "problems/parent": posting("parent"), "proposals/selected": proposal("selected", { problemId: "parent" }) };
  for (let index = 0; index < count; index++) {
    records[`comments/c${String(index).padStart(5, "0")}`] = comment({ proposalId: "selected", body: `Comment ${index}`, ...extra });
  }
  return records;
}

// Decorate the existing fake with Firestore's authoritative snapshot timestamps.
// Application fields are left untouched so legacy date behavior stays testable.
function systemTimedDb(db, created = new Map(), readTime = exportNow) {
  const original = db.collection;
  const wrap = (query, name) => ({
    doc: (...args) => query.doc(...args),
    ...Object.fromEntries(["where", "select", "orderBy", "limit", "startAfter"].map((method) => [method, (...args) => wrap(query[method](...args), name)])),
    get: async () => {
      const rows = await query.get();
      return { ...rows, readTime, docs: rows.docs.map((doc) => ({ ...doc, createTime: created.get(`${name}/${doc.id}`) || at("2026-01-01T00:00:00.000Z") })) };
    },
  });
  db.collection = (name) => wrap(original(name), name);
  return db;
}

describe("bounded proposal export continuation", () => {
  it("requires explicit protocol opt-in so stale clients never save a partial file", async () => {
    const db = store(floodRecords(51));
    await assert.rejects(() => callPage(db, { proposalId: "selected" }), { code: "failed-precondition" });
    assert.equal(audits(db).length, 0);
    assert.equal([...db.records.keys()].some((key) => key.startsWith(`${EXPORT_SESSION_COLLECTION}/`)), false);
  });

  it("pages at 50 documents, retries exactly, and commits one complete audit under concurrent retries", async () => {
    const queries = [];
    const db = memoryDb(floodRecords(51), { onQuery: (query) => queries.push(query) });
    const first = await callPage(db, beginInput());
    assert.equal(first.document.commentCount, EXPORT_COMMENT_PAGE_SIZE);
    assert.equal(first.done, false);
    assert.equal(first.auditId, null);
    assert.equal(audits(db).length, 0);
    assert.deepEqual(await callPage(db, beginInput()), first);
    await assert.rejects(() => callPage(db, { exportId: first.exportId, page: 2 }), { code: "failed-precondition" });
    const [last, retry] = await Promise.all([callPage(db, first.nextCursor), callPage(db, first.nextCursor)]);
    assert.deepEqual(retry, last);
    assert.deepEqual(await callPage(db, first.nextCursor), last);
    assert.equal(last.done, true);
    assert.equal(last.document.commentCount, 1);
    assert.equal(last.totals.commentCount, 51);
    assert.equal(audits(db).length, 1);
    assert.equal(audits(db)[0][1].commentCount, 51);
    assert.ok(queries.filter((row) => row.name === "comments").every((row) => row.cap <= EXPORT_COMMENT_PAGE_SIZE));
    await assert.rejects(() => callPage(db, beginInput()), { code: "failed-precondition" });
    await assert.rejects(() => callPage(db, { exportId: first.exportId, page: 2 }), { code: "failed-precondition" });
  });

  it("does not drop the exact page-size boundary and completes after the bounded empty continuation", async () => {
    const db = store(floodRecords(50));
    const result = await exportOf(db, beginInput());
    assert.equal(result.commentCount, 50);
    assert.equal(audits(db).length, 1);
  });

  it("binds session state to actor, scope, expiry and sequential validated cursors", async () => {
    const db = store(floodRecords(51));
    const first = await callPage(db, beginInput());
    await assert.rejects(() => callPage(db, first.nextCursor, { actorUid: "other-admin" }), { code: "permission-denied" });
    await assert.rejects(() => callPage(db, beginInput({ acceptance: "accepted" })), { code: "invalid-argument" });
    await assert.rejects(() => callPage(db, { ...first.nextCursor, proposalId: "other" }), { code: "invalid-argument" });
    await assert.rejects(() => callPage(db, { exportId: first.exportId, page: -1 }), { code: "invalid-argument" });
    await assert.rejects(() => callPage(db, { exportId: "a".repeat(64), page: 1 }), { code: "not-found" });
    await assert.rejects(() => callPage(db, first.nextCursor, { now: Timestamp.fromMillis(exportNow.toMillis() + EXPORT_SESSION_TTL_MS + 1) }), { code: "failed-precondition" });
    assert.equal(audits(db).length, 0);
    assert.equal([...db.records.keys()].filter((key) => key.startsWith(`${EXPORT_SESSION_COLLECTION}/`)).length, 1);
  });

  it("uses system creation times and a monotonic ID scan while retaining all legacy application dates", async () => {
    const records = floodRecords(51);
    records["comments/c00000"].createdAt = at("2099-01-01T00:00:00.000Z");
    records["comments/c00001"].createdAt = null;
    records["comments/c00002"].createdAt = "malformed old date";
    const created = new Map();
    const db = systemTimedDb(store(records), created);
    const first = await callPage(db, beginInput());
    assert.equal(first.document.postings[0].proposals[0].comments[0].createdAt, "2099-01-01T00:00:00.000Z");
    assert.equal(first.document.postings[0].proposals[0].comments[1].createdAt, null);
    assert.equal(first.document.postings[0].proposals[0].comments[2].createdAt, null);
    // Created later but sorting before an old unexported row: skip by immutable system time,
    // including a timestamp only one nanosecond after the cutoff.
    db.records.set("comments/c00049x", comment({ proposalId: "selected", createdAt: null }));
    created.set("comments/c00049x", new Timestamp(exportNow.seconds, exportNow.nanoseconds + 1));
    // Later IDs also advance the bounded scan and are excluded by system time.
    db.records.set("comments/z-new", comment({ proposalId: "selected", createdAt: at("2020-01-01T00:00:00.000Z") }));
    created.set("comments/z-new", at("2026-10-28T00:00:00.000Z"));
    db.records.get("comments/c00050").body = "A current edit made between pages.";
    const last = await callPage(db, first.nextCursor);
    assert.equal(last.done, true);
    assert.equal(last.totals.commentCount, 51);
    assert.deepEqual(last.document.postings[0].proposals[0].comments.map((row) => row.id), ["c00050"]);
    assert.equal(last.document.postings[0].proposals[0].comments[0].body, "A current edit made between pages.");
  });

  it("bounds UTF-8 page and session bytes without truncating maximum-length multibyte bodies", async () => {
    const body = "漢".repeat(5000);
    const queries = [];
    const db = memoryDb(floodRecords(101, { body, revisions: [{ body: "not exported".repeat(10000) }] }), { onQuery: (query) => queries.push(query) });
    let page = await callPage(db, beginInput());
    const ids = new Set();
    let pages = 0;
    while (true) {
      pages++;
      assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= EXPORT_PAGE_BYTES);
      for (const row of page.document.postings[0].proposals[0].comments) { assert.equal(row.body, body); ids.add(row.id); }
      const state = db.records.get(`${EXPORT_SESSION_COLLECTION}/${page.exportId}`);
      assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") <= EXPORT_SESSION_BYTES);
      assert.equal(Object.hasOwn(state, "pages"), false);
      if (page.done) break;
      page = await callPage(db, page.nextCursor);
    }
    assert.ok(pages > 3);
    assert.equal(ids.size, 101);
    assert.equal(page.totals.commentCount, 101);
    assert.equal(audits(db).length, 1);
    assert.ok(queries.filter((row) => row.name === "comments").every((row) => row.cap <= EXPORT_COMMENT_PAGE_SIZE));
  });

  it("returns no audit and no cursor advancement when an individual legacy row exceeds the byte budget", async () => {
    const db = store(floodRecords(1, { body: "x".repeat(EXPORT_PAGE_BYTES) }));
    await assert.rejects(() => callPage(db, beginInput()), { code: "resource-exhausted" });
    assert.equal(audits(db).length, 0);
    assert.equal([...db.records.keys()].some((key) => key.startsWith(`${EXPORT_SESSION_COLLECTION}/`)), false);
  });

  it("keeps the global 500-proposal scan cap separate and gives an accurate single-proposal workaround", async () => {
    const records = {};
    for (let index = 0; index <= EXPORT_SCAN_CAP; index++) records[`proposals/p${index}`] = proposal(`p${index}`, { problemId: null });
    const db = store(records);
    await assert.rejects(() => callPage(db, { protocolVersion: 1, startDate: "2026-10-01", endDate: "2026-10-02" }), (error) => error.code === "resource-exhausted" && /shorter date range cannot/.test(error.message));
    const selected = await exportOf(db, { proposalId: "p0" });
    assert.equal(selected.proposalCount, 1);
    assert.equal(selected.document.postings[0].id, "");
  });
});

it("preserves separate missing-parent groups and stable posting metadata across sibling proposals", async () => {
  const records = floodRecords(1);
  records["proposals/sibling"] = proposal("sibling", { problemId: "parent" });
  records["proposals/orphan-a"] = proposal("orphan-a", { problemId: "missing-a" });
  records["proposals/orphan-b"] = proposal("orphan-b", { problemId: "missing-b" });
  const db = store(records);
  let page = await callPage(db, { protocolVersion: 1, startDate: "2026-09-01", endDate: "2026-10-27" });
  const headers = new Map(), proposals = [];
  while (true) {
    const posting = page.document.postings[0];
    const header = { ...posting, proposals: [] };
    if (headers.has(page.postingIndex)) assert.deepEqual(header, headers.get(page.postingIndex));
    else headers.set(page.postingIndex, header);
    proposals.push(posting.proposals[0].id);
    // The first parent proposal's group header must survive this update.
    if (posting.id === "parent") db.records.get("problems/parent").title = "Edited between sibling pages";
    if (page.done) break;
    page = await callPage(db, page.nextCursor);
  }
  assert.equal(headers.size, 3);
  assert.equal([...headers.values()].filter((posting) => posting.id === "").length, 2);
  assert.equal(proposals.length, 4);
  assert.equal(page.totals.postingCount, 3);
  assert.equal(page.totals.proposalCount, 4);
});

it("does not advance a session or audit a failed intermediate page", async () => {
  const records = floodRecords(51);
  records["comments/c00050"].body = "x".repeat(EXPORT_PAGE_BYTES);
  const db = store(records);
  const first = await callPage(db, beginInput());
  const before = JSON.stringify(db.records.get(`${EXPORT_SESSION_COLLECTION}/${first.exportId}`));
  await assert.rejects(() => callPage(db, first.nextCursor), { code: "resource-exhausted" });
  assert.equal(JSON.stringify(db.records.get(`${EXPORT_SESSION_COLLECTION}/${first.exportId}`)), before);
  assert.equal(audits(db).length, 0);
  db.records.get("comments/c00050").body = "Repaired legacy row";
  const last = await callPage(db, first.nextCursor);
  assert.equal(last.done, true);
  assert.equal(last.totals.commentCount, 51);
  assert.equal(audits(db).length, 1);
});

it("keeps exact JSON bodies and shared CSV formula/quoting rules across pages", async () => {
  const db = store(floodRecords(53));
  const bodies = ["=SUM(A1)", "+formula", "-formula", "@formula", 'Quotes "and commas",\r\nsecond line'];
  bodies.forEach((body, index) => { db.records.get(`comments/c${String(48 + index).padStart(5, "0")}`).body = body; });
  const result = await exportOf(db, { proposalId: "selected" });
  const comments = result.document.postings[0].proposals[0].comments;
  for (let index = 0; index < bodies.length; index++) assert.equal(comments.find((row) => row.id === `c${String(48 + index).padStart(5, "0")}`).body, bodies[index]);
  for (const prefix of ["=SUM(A1)", "+formula", "-formula", "@formula"]) assert.ok(result.csv.includes(`'${prefix}`));
  assert.ok(result.csv.includes('"Quotes ""and commas"",\r\nsecond line"'));
  assertConforms(schema, result.document, "document.");
});

it("emits no false zero-comment row for an exact 50-comment page followed by an empty scan", async () => {
  const records = floodRecords(50);
  records["comments/z-unrelated"] = comment({ proposalId: "outside" });
  records["proposals/zero"] = proposal("zero", { problemId: "parent" });
  const db = store(records);
  let page = await callPage(db, { protocolVersion: 1, startDate: "2026-09-01", endDate: "2026-10-27" });
  let csvRows = 0, emptyProgressPages = 0, zeroRows = 0;
  while (true) {
    csvRows += exportToCsv(page.document).split("\r\n").length - 2;
    if (!page.document.postings.length) emptyProgressPages++;
    for (const posting of page.document.postings) for (const proposal of posting.proposals) {
      if (!proposal.comments.length) { zeroRows++; assert.equal(proposal.id, "zero"); }
    }
    if (page.done) break;
    page = await callPage(db, page.nextCursor);
  }
  assert.equal(emptyProgressPages, 1);
  assert.equal(zeroRows, 1);
  assert.equal(csvRows, 51); // Independently flushed page files remain complete.
  assert.equal(page.totals.commentCount, 50);
  assert.equal(audits(db)[0][1].commentCount, 50);
});

it("emits only genuine empty proposals once after future-only progress pages", async () => {
  const records = floodRecords(50);
  records["comments/z-unrelated"] = comment({ proposalId: "outside" });
  records["proposals/zero"] = proposal("zero", { problemId: "parent" });
  const created = new Map(), db = systemTimedDb(store(records), created);
  let page = await callPage(db, { protocolVersion: 1, startDate: "2026-09-01", endDate: "2026-10-27" });
  assert.equal(page.document.commentCount, 50);
  for (let index = 0; index < 51; index++) {
    for (const [prefix, proposalId] of [["d", "selected"], ["q", "zero"]]) {
      const path = `comments/${prefix}${String(index).padStart(5, "0")}`;
      db.records.set(path, comment({ proposalId, createdAt: null }));
      created.set(path, new Timestamp(exportNow.seconds, exportNow.nanoseconds + 1));
    }
  }
  let csvRows = 0, emptyProgressPages = 0, zeroRows = 0;
  while (true) {
    assertConforms(schema, page.document, "page.document.");
    csvRows += exportToCsv(page.document).split("\r\n").length - 2;
    if (!page.document.postings.length) emptyProgressPages++;
    for (const posting of page.document.postings) for (const proposal of posting.proposals) {
      if (!proposal.comments.length) { zeroRows++; assert.equal(proposal.id, "zero"); }
    }
    if (page.done) break;
    page = await callPage(db, page.nextCursor);
  }
  assert.equal(emptyProgressPages, 3);
  assert.equal(zeroRows, 1);
  assert.equal(csvRows, 51);
  assert.equal(page.totals.commentCount, 50);
  assert.equal(audits(db).length, 1);
  assert.equal(audits(db)[0][1].proposalCount, 2);
  assert.equal(audits(db)[0][1].commentCount, 50);
});

it("retries an initial request when Firestore returns equivalent scope fields in a different map order", async () => {
  const db = store(floodRecords(51));
  const first = await callPage(db, beginInput());
  assert.equal(first.done, false);
  const state = db.records.get(`${EXPORT_SESSION_COLLECTION}/${first.exportId}`);
  state.scope = Object.fromEntries(Object.entries(state.scope).reverse());
  const before = JSON.stringify(state);
  assert.deepEqual(await callPage(db, beginInput()), first);
  assert.equal(JSON.stringify(db.records.get(`${EXPORT_SESSION_COLLECTION}/${first.exportId}`)), before);
  assert.equal(state.lastPage, 0);
  assert.equal(state.commentCount, 50);
  assert.equal(audits(db).length, 0);
  await assert.rejects(() => callPage(db, beginInput({ acceptance: "accepted" })), { code: "invalid-argument" });
  state.scope.unexpected = true;
  await assert.rejects(() => callPage(db, beginInput()), { code: "invalid-argument" });
  assert.equal(audits(db).length, 0);
});
